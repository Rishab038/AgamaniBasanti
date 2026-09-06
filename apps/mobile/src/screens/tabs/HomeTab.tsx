// Home — the worker's day as a ledger and a slab.
//
//   1 Check in           arrival
//   2 Going for lunch    out for the break
//   3 Back on the floor  return to the floor
//   4 Check out          going home
//
// Two halves. The LEDGER lists all four stamps at once, so the day is
// legible before anything is tapped and a worker can see what they have
// already done rather than trusting a label. The SLAB is the single
// action, pinned below the scroll so it is never scrolled away from —
// on the old screen it sat in the page and a long day pushed it off.
//
// The slab always says exactly what the next tap does, and there is
// nothing else on screen to choose. After the fourth tap the day is
// closed and the slab goes quiet.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import * as Updates from "expo-updates";
import { Branch, Profile } from "../../lib/supabase";
import { evaluateFence, FenceResult } from "../../lib/geofence";
import { runSpoofChecks } from "../../lib/antispoof";
import { performCheckin } from "../../lib/checkin";
import { colors, fonts, radius } from "../../lib/theme";
import PhotoCapture from "../../components/PhotoCapture";
import type { PunchKind, SharedData } from "../MainScreen";

const GRACE_MIN = 15;

const fmtShiftTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")}`;
};
const fmtClock = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
const fmtPunch = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

function minutesFrom(now: Date, hhmmss: string | null): number | null {
  if (!hhmmss) return null;
  const [h, m] = hhmmss.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return Math.round((now.getTime() - target.getTime()) / 60000);
}

type Stage = {
  kind: PunchKind;
  direction: "IN" | "OUT";
  label: string;
  hint: string;
  kicker: string;
};

/** The four stamps, in the order the day makes them. */
const ORDER: PunchKind[] = ["ARRIVAL", "LUNCH_OUT", "LUNCH_IN", "DEPARTURE"];

const STAGES: Stage[] = [
  { kind: "ARRIVAL", direction: "IN", label: "Check in", hint: "Start your day", kicker: "Tap to begin" },
  { kind: "LUNCH_OUT", direction: "OUT", label: "Going for\nlunch", hint: "Start your break", kicker: "Next" },
  { kind: "LUNCH_IN", direction: "IN", label: "Back on\nthe floor", hint: "Return to work", kicker: "Next" },
  { kind: "DEPARTURE", direction: "OUT", label: "Check out", hint: "Finish your day", kicker: "Last one" },
];

/** What the ledger calls each stamp once it exists. */
const KIND_LABEL: Record<string, string> = {
  ARRIVAL: "Checked in",
  LUNCH_OUT: "Lunch break",
  LUNCH_IN: "Back from lunch",
  DEPARTURE: "Checked out",
};

export default function HomeTab({
  profile,
  branch,
  data,
  active = true,
}: {
  profile: Profile;
  branch: Branch;
  data: SharedData;
  /** false while another tab is on screen: this one stays mounted but
   *  must not hold the GPS radio open behind it */
  active?: boolean;
}) {
  // A ref, not state. The fix is only ever read inside punch(), never
  // drawn, so storing it in state re-rendered this screen every twelve
  // seconds for the whole time the app was open and changed nothing on
  // it. The geofence result below is the part the screen actually shows.
  const location = useRef<Location.LocationObject | null>(null);
  const [fence, setFence] = useState<FenceResult>({ inside: false, distance: null, via: "none" });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [success, setSuccess] = useState<{ title: string; sub: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const press = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  const punches = data.todayPunches;

  // The ledger, and with it everything else this screen shows: at what
  // time each of the four stamps happened, in order, with nulls for the
  // ones still to come. Derived once rather than searched four times.
  const stamps = useMemo(() => {
    const at = new Map<string, string>();
    for (const p of punches) if (p.punch_kind) at.set(p.punch_kind, p.server_ts);
    return ORDER.map((k) => at.get(k) ?? null);
  }, [punches]);

  const doneCount = stamps.filter(Boolean).length;
  const nextIndex = stamps.findIndex((t) => t === null);
  const stage = nextIndex === -1 ? null : STAGES[nextIndex];
  const dayClosed = stage === null;
  const enabled = fence.inside && !busy && !dayClosed;

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const absent = data.monthDays.filter((d) => d.status === "ABSENT").length;

  // The one animation on this screen. Opacity only and native-driven,
  // so no JavaScript runs per frame and nothing above it re-renders —
  // and it is stopped entirely whenever the worker is on another tab or
  // away from the shop, which is most of the day.
  const pulse = useRef(new Animated.Value(0.35)).current;
  const live = active && fence.inside;
  useEffect(() => {
    if (!live) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 1200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  useEffect(() => {
    // Paused while the worker is on another tab. The screen keeps its
    // last known fence, so coming back shows the slab live straight
    // away instead of falling back to "Finding your location…".
    if (!active) return;
    let sub: Location.LocationSubscription | undefined;
    let stopped = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setLocGranted(status === "granted");
      if (status !== "granted") return;
      // Balanced accuracy (~100 m, wifi/cell assisted) every 12 s is
      // plenty for a 100 m geofence and far lighter than High/5 s, which
      // kept the GPS radio hot and made the whole app feel sluggish.
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 12000, distanceInterval: 15 },
        (loc) => {
          location.current = loc;
          const next = evaluateFence({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            accuracy: loc.coords.accuracy,
            branchLat: branch.lat,
            branchLng: branch.lng,
            radiusM: branch.radius_m,
            currentSsid: null,
            branchSsid: branch.wifi_ssid,
          });
          // Standing still still produces a new fix every twelve seconds,
          // and evaluateFence returns a fresh object each time — so this
          // re-rendered on a timer all day. Only three fields are drawn.
          setFence((prev) =>
            prev.inside === next.inside &&
            prev.distance === next.distance &&
            prev.via === next.via
              ? prev
              : next,
          );
        },
      );
      if (stopped) sub.remove();   // tab switched while the watch was starting
    })();
    return () => {
      stopped = true;
      sub?.remove();
    };
  }, [branch, active]);

  const onRefresh = async () => {
    setRefreshing(true);
    await data.reload();
    setRefreshing(false);
  };

  const showSuccess = (title: string, sub: string) => {
    setSuccess({ title, sub });
    successAnim.setValue(0);
    Animated.sequence([
      Animated.spring(successAnim, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 8 }),
      Animated.delay(1800),
      Animated.timing(successAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start(() => setSuccess(null));
  };

  // Arrival is the punch the geofence has to get right, so that is the
  // one that carries a photo. Lunch and departure stay one tap — the
  // person is already established as present by then.
  const [photoFor, setPhotoFor] = useState<Stage | null>(null);

  const startPunch = (s: Stage) => {
    if (busy) return;
    if (s.kind === "ARRIVAL") setPhotoFor(s);
    else punch(s);
  };

  /** record a punch; photo is optional and never blocks it */
  const punch = async (s: Stage, photoBase64: string | null = null) => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setBlocked(null);
    try {
      const spoof = location.current
        ? await runSpoofChecks(location.current)
        : { hardBlock: false, reasons: ["no_gps_fix"] };
      if (spoof.hardBlock) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setBlocked("Location problem detected. Switch off any fake-location app and try again.");
        return;
      }

      const { queued } = await performCheckin({
        profileId: profile.id,
        branchId: branch.id,
        direction: s.direction,
        punchKind: s.kind,
        location: location.current,
        wifiSsid: null,
        flagReasons: [
          ...spoof.reasons,
          ...(fence.via === "wifi" ? ["wifi_fallback"] : []),
          // worth knowing later why a doubtful fence has no photo to check
          ...(s.kind === "ARRIVAL" && !photoBase64 ? ["no_photo"] : []),
        ],
        photoBase64,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showSuccess(
        KIND_LABEL[s.kind],
        queued ? "Saved — sends when internet returns" : `at ${fmtClock(new Date())}`,
      );
      await data.reload();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = (e as Error)?.message ?? "";
      setBlocked(
        msg.includes("full day")
          ? "You have already recorded your full day."
          : "Something went wrong. Please try again in a minute.",
      );
    } finally {
      setBusy(false);
    }
  };

  // out-of-window warning for the stage about to be recorded
  const shiftNotice = (() => {
    if (!stage) return null;
    if (stage.kind === "ARRIVAL") {
      const d = minutesFrom(new Date(), profile.shift_start);
      if (d === null) return null;
      if (d > GRACE_MIN) return "You are late — the owner will be asked to approve this.";
      if (d < -GRACE_MIN) return "It is early for your shift — the owner will be asked to approve.";
    }
    if (stage.kind === "DEPARTURE") {
      const d = minutesFrom(new Date(), profile.shift_end);
      if (d === null) return null;
      if (d < -GRACE_MIN) return "Leaving before your shift ends — the owner will decide how this day counts.";
      if (d > GRACE_MIN) return "You are staying past your shift end — this will be sent for approval.";
    }
    return null;
  })();

  const initials = profile.full_name.trim()[0]?.toUpperCase() ?? "?";
  const firstName = profile.full_name.trim().split(/\s+/)[0];
  const shiftLine = profile.shift_start
    ? `${fmtShiftTime(profile.shift_start)} – ${fmtShiftTime(profile.shift_end ?? "")}`
    : null;

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollInner}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        <View style={styles.header}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.kicker}>
              {new Date()
                .toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })
                .toUpperCase()}
            </Text>
            <Text style={styles.name} numberOfLines={1}>{firstName}</Text>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </View>

        {/* where they are, in one line */}
        <View style={[styles.place, fence.inside ? styles.placeGood : styles.placeNeutral]}>
          <Animated.View
            style={[
              styles.placeDot,
              {
                backgroundColor: fence.inside ? colors.good : colors.mute,
                opacity: live ? pulse : 1,
              },
            ]}
          />
          <Text style={styles.placeText} numberOfLines={2}>
            {locGranted === false
              ? "Allow location to check in at the shop"
              : fence.inside
                ? "You are at the shop"
                : fence.distance !== null
                  ? "You are away from the shop"
                  : "Finding your location…"}
          </Text>
          {fence.distance !== null && (
            <Text style={styles.placeMeta}>{fence.distance} m</Text>
          )}
        </View>

        {/* the ledger: all four stamps, whether or not they exist yet */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>Today</Text>
            <Text style={styles.cardMeta}>
              {dayClosed ? "All four done" : `${doneCount} of 4 done`}
            </Text>
          </View>
          {ORDER.map((kind, n) => {
            const at = stamps[n];
            const isNext = n === nextIndex;
            return (
              <View key={kind} style={styles.step}>
                <View
                  style={[
                    styles.stepNum,
                    at ? styles.stepNumDone : isNext ? styles.stepNumNext : styles.stepNumTodo,
                  ]}
                >
                  <Text
                    style={[
                      styles.stepNumText,
                      at ? styles.stepNumTextDone
                        : isNext ? styles.stepNumTextNext
                        : styles.stepNumTextTodo,
                    ]}
                  >
                    {n + 1}
                  </Text>
                </View>
                <Text
                  style={[styles.stepLabel, !at && !isNext && styles.stepLabelTodo]}
                  numberOfLines={1}
                >
                  {KIND_LABEL[kind]}
                </Text>
                <Text
                  style={[
                    styles.stepTime,
                    at ? styles.stepTimeDone : isNext ? styles.stepTimeNext : styles.stepTimeTodo,
                  ]}
                >
                  {at ? fmtPunch(at) : isNext ? "— now" : "—"}
                </Text>
              </View>
            );
          })}
        </View>

        {/* the month, in three numbers */}
        <View style={styles.tiles}>
          <View style={styles.tile}>
            <Text style={styles.tileValue}>{worked}</Text>
            <Text style={styles.tileLabel}>Days{"\n"}present</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileValue}>{absent}</Text>
            <Text style={styles.tileLabel}>Days{"\n"}absent</Text>
          </View>
          <View style={[styles.tile, styles.tileAccent]}>
            <Text style={[styles.tileValue, styles.tileValueAccent]}>
              {data.advancePaid.toLocaleString("en-IN")}
            </Text>
            <Text style={styles.tileLabel}>Advance{"\n"}in rupees</Text>
          </View>
        </View>

        {data.pending > 0 && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {data.pending} check-in{data.pending > 1 ? "s" : ""} saved — will send when internet returns
            </Text>
          </View>
        )}
        {/* Different problem, different words. These are not waiting on a
            network, so telling the worker to wait for one leaves them
            pressing the slab again and again. */}
        {data.stuck > 0 && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {data.stuck} check-in{data.stuck > 1 ? "s" : ""} could not be sent. Your other
              entries are fine — please show this message to the owner.
            </Text>
          </View>
        )}
        {blocked && (
          <Pressable style={[styles.notice, styles.noticeBad]} onPress={() => setBlocked(null)}>
            <Text style={[styles.noticeText, styles.noticeTextBad]}>{blocked}</Text>
          </Pressable>
        )}
        {shiftNotice && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{shiftNotice}</Text>
          </View>
        )}

        <Text style={styles.footnote}>
          Time and location are recorded with every entry.
          {shiftLine ? ` Your shift is ${shiftLine}.` : ""}
        </Text>
      </ScrollView>

      {/* The slab. Outside the scroll on purpose: this is the only thing
          on the screen anyone came to press, and on a long day the old
          in-page button could be scrolled out of reach. */}
      <View style={styles.slabWrap}>
        <Animated.View style={{ transform: [{ scale: press }] }}>
          <Pressable
            onPressIn={() =>
              Animated.spring(press, { toValue: 0.97, useNativeDriver: true, speed: 30 }).start()
            }
            onPressOut={() =>
              Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18 }).start()
            }
            onPress={() => stage && startPunch(stage)}
            disabled={!enabled}
            style={[
              styles.slab,
              dayClosed ? styles.slabDone : enabled ? styles.slabLive : styles.slabOff,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.accentInk} />
            ) : (
              <>
                <View style={styles.slabHead}>
                  <Text style={[styles.slabKicker, !enabled && styles.slabInkOff]}>
                    {dayClosed ? "FINISHED" : stage!.kicker.toUpperCase()}
                  </Text>
                  <Text style={[styles.slabKicker, !enabled && styles.slabInkOff]}>
                    {fmtClock(new Date())}
                  </Text>
                </View>
                <Text style={[styles.slabLabel, !enabled && styles.slabInkOff]}>
                  {dayClosed ? "Day\ncomplete" : stage!.label}
                </Text>
                <View style={styles.slabFoot}>
                  <View style={[styles.slabRule, !enabled && styles.slabRuleOff]} />
                  <Text style={[styles.slabHint, !enabled && styles.slabInkOff]}>
                    {dayClosed
                      ? "Nothing left to tap"
                      : locGranted === false
                        ? "Allow location first"
                        : enabled
                          ? stage!.hint
                          : "Come closer to the shop"}
                  </Text>
                </View>
              </>
            )}
          </Pressable>
        </Animated.View>

        {/* Which code the phone is actually running. Invisible in normal
            use, but when someone says "the new thing isn't showing", this
            is the difference between guessing and knowing. */}
        <Text style={styles.buildLine}>
          {Updates.isEmbeddedLaunch ? "app build" : "update"}
          {Updates.createdAt
            ? ` · ${Updates.createdAt.toLocaleDateString("en-IN", {
                day: "numeric", month: "short",
              })} ${Updates.createdAt.toLocaleTimeString("en-IN", {
                hour: "numeric", minute: "2-digit",
              })}`
            : ""}
        </Text>
      </View>

      {success && (
        <Animated.View style={[styles.successWrap, { opacity: successAnim }]} pointerEvents="none">
          <View style={styles.successTick}>
            <Text style={styles.successTickText}>✓</Text>
          </View>
          <Text style={styles.successTitle}>{success.title}</Text>
          <Text style={styles.successSub}>{success.sub}</Text>
        </Animated.View>
      )}

      <PhotoCapture
        visible={photoFor !== null}
        onDone={(b64) => {
          const s = photoFor;
          setPhotoFor(null);
          if (s) punch(s, b64);          // a skipped or failed photo still checks in
        }}
        onCancel={() => setPhotoFor(null)}   // backing out records nothing
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollInner: { padding: 16, paddingTop: 22, paddingBottom: 8 },

  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 6, paddingBottom: 18 },
  kicker: { fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.5, color: colors.ink3 },
  name: {
    fontFamily: fonts.semi, fontSize: 32, lineHeight: 34,
    letterSpacing: -1, color: colors.ink, marginTop: 9,
  },
  avatar: {
    width: 48, height: 48, borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.extra, fontSize: 19, color: colors.accentLight },

  place: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 15, paddingHorizontal: 18, borderRadius: radius.md,
  },
  placeGood: { backgroundColor: colors.goodBg },
  placeNeutral: { backgroundColor: colors.track },
  placeDot: { width: 8, height: 8, borderRadius: 4 },
  placeText: { flex: 1, fontFamily: fonts.semi, fontSize: 13.5, lineHeight: 18, color: colors.ink },
  placeMeta: { fontFamily: fonts.semi, fontSize: 11.5, color: colors.ink3 },

  card: {
    borderRadius: radius.lg, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8, marginTop: 12,
  },
  cardHead: {
    flexDirection: "row", alignItems: "baseline",
    justifyContent: "space-between", paddingBottom: 8,
  },
  cardTitle: { fontFamily: fonts.extra, fontSize: 14.5, letterSpacing: -0.2, color: colors.ink },
  cardMeta: { fontFamily: fonts.semi, fontSize: 11.5, color: colors.ink3 },

  step: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14 },
  stepNum: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  stepNumDone: { backgroundColor: colors.accentSoft },
  stepNumNext: { backgroundColor: colors.accent },
  stepNumTodo: { borderWidth: 1, borderColor: colors.track },
  stepNumText: { fontFamily: fonts.extra, fontSize: 12 },
  stepNumTextDone: { color: colors.accentLight },
  stepNumTextNext: { color: colors.accentInk },
  stepNumTextTodo: { color: colors.mute },
  stepLabel: {
    flex: 1, fontFamily: fonts.extra, fontSize: 16,
    letterSpacing: -0.2, color: colors.ink,
  },
  stepLabelTodo: { fontFamily: fonts.regular, color: colors.mute },
  stepTime: { fontFamily: fonts.extra, fontSize: 15 },
  stepTimeDone: { color: colors.ink },
  stepTimeNext: { color: colors.accent },
  stepTimeTodo: { color: colors.mute },

  tiles: { flexDirection: "row", gap: 8, marginTop: 12 },
  tile: {
    flex: 1, borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line, padding: 16,
  },
  tileAccent: { backgroundColor: colors.accentSoft, borderColor: "rgba(145,132,217,0.22)" },
  tileValue: { fontFamily: fonts.extra, fontSize: 26, letterSpacing: -0.8, color: colors.ink },
  tileValueAccent: { color: colors.accentLight },
  tileLabel: { fontFamily: fonts.semi, fontSize: 11, lineHeight: 15, color: colors.ink3, marginTop: 8 },

  notice: {
    borderRadius: radius.md, backgroundColor: colors.amberBg,
    borderWidth: 1, borderColor: "rgba(229,165,82,0.22)",
    padding: 14, marginTop: 12,
  },
  noticeText: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.ink2 },
  noticeBad: { backgroundColor: colors.seriousBg, borderColor: "rgba(229,119,107,0.26)" },
  noticeTextBad: { color: colors.serious },

  footnote: {
    fontFamily: fonts.regular, fontSize: 11.5, lineHeight: 18,
    color: colors.mute, marginTop: 16, marginHorizontal: 6,
  },

  slabWrap: { paddingHorizontal: 16, paddingBottom: 6 },
  slab: { borderRadius: radius.xl, paddingHorizontal: 24, paddingVertical: 26, minHeight: 150 },
  slabLive: { backgroundColor: colors.accent },
  slabOff: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  slabDone: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  slabHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  slabKicker: {
    fontFamily: fonts.semi, fontSize: 11, letterSpacing: 1.6,
    color: colors.accentInk, opacity: 0.72,
  },
  slabLabel: {
    fontFamily: fonts.extra, fontSize: 38, lineHeight: 40,
    letterSpacing: -1.4, color: colors.accentInk, marginTop: 16,
  },
  slabFoot: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16 },
  slabRule: { flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.accentInk, opacity: 0.28 },
  slabRuleOff: { backgroundColor: colors.mute, opacity: 1 },
  slabHint: { fontFamily: fonts.semi, fontSize: 12.5, color: colors.accentInk, opacity: 0.85 },
  // one override for every piece of ink on a slab that is not live
  slabInkOff: { color: colors.ink3, opacity: 1 },

  buildLine: {
    fontFamily: fonts.regular, fontSize: 10,
    color: colors.mute, textAlign: "center", marginTop: 8,
  },

  successWrap: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: colors.accentDeep,
    justifyContent: "flex-end", padding: 28, paddingBottom: 64,
  },
  successTick: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: "rgba(245,244,255,0.14)",
    alignItems: "center", justifyContent: "center",
  },
  successTickText: { fontFamily: fonts.regular, fontSize: 44, color: "#f5f4ff" },
  successTitle: {
    fontFamily: fonts.semi, fontSize: 40, lineHeight: 42,
    letterSpacing: -1.6, color: "#f5f4ff", marginTop: 26,
  },
  successSub: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: "#d2cefd", marginTop: 12 },
});
