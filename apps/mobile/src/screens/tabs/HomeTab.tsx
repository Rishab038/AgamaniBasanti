// Home tab — the worker's day, as four steps.
//
//   1 CHECK IN        arrival
//   2 LUNCH BREAK     out for the one-hour break (or CHECK OUT to go home)
//   3 BACK FROM LUNCH return to the floor
//   4 CHECK OUT       going home
//
// After the fourth the day is closed. Modelling it as named stages
// rather than an IN/OUT toggle is what lets the app say exactly what
// the next tap will do — and stops the lunch hour being counted as
// time on the floor.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { Branch, Profile, supabase } from "../../lib/supabase";
import { evaluateFence, FenceResult } from "../../lib/geofence";
import { runSpoofChecks } from "../../lib/antispoof";
import { performCheckin } from "../../lib/checkin";
import { pendingCount } from "../../lib/queue";
import { colors, fonts, radius, shadow } from "../../lib/theme";
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
  tone: "start" | "break" | "end";
};

/** what the next tap does, from what has already been recorded today */
function nextStage(kinds: (PunchKind | null)[]): Stage | null {
  const has = (k: PunchKind) => kinds.includes(k);
  if (!has("ARRIVAL")) {
    return {
      kind: "ARRIVAL", direction: "IN",
      label: "CHECK IN", hint: "Start your day", tone: "start",
    };
  }
  if (has("DEPARTURE")) return null;             // day already closed
  if (has("LUNCH_OUT") && !has("LUNCH_IN")) {
    return {
      kind: "LUNCH_IN", direction: "IN",
      label: "BACK FROM\nLUNCH", hint: "Return to work", tone: "start",
    };
  }
  return {
    kind: "DEPARTURE", direction: "OUT",
    label: "CHECK OUT", hint: "Finish your day", tone: "end",
  };
}

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
}: {
  profile: Profile;
  branch: Branch;
  data: SharedData;
}) {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [fence, setFence] = useState<FenceResult>({ inside: false, distance: null, via: "none" });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [success, setSuccess] = useState<{ title: string; sub: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const press = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  const punches = data.todayPunches;
  const kinds = punches.map((p) => p.punch_kind);
  const stage = nextStage(kinds);
  const dayClosed = stage === null;
  const canTakeLunch =
    kinds.includes("ARRIVAL") && !kinds.includes("LUNCH_OUT") && !kinds.includes("DEPARTURE");
  const enabled = fence.inside && !busy && !dayClosed;

  const worked = data.monthDays.filter((d) =>
    ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(d.status),
  ).length;
  const absent = data.monthDays.filter((d) => d.status === "ABSENT").length;

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      setLocGranted(status === "granted");
      if (status !== "granted") return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
        (loc) => {
          setLocation(loc);
          setFence(
            evaluateFence({
              lat: loc.coords.latitude,
              lng: loc.coords.longitude,
              accuracy: loc.coords.accuracy,
              branchLat: branch.lat,
              branchLng: branch.lng,
              radiusM: branch.radius_m,
              currentSsid: null,
              branchSsid: branch.wifi_ssid,
            }),
          );
        },
      );
    })();
    return () => sub?.remove();
  }, [branch]);

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

  /** record a punch — one tap, no camera step */
  const punch = async (s: Stage) => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setBlocked(null);
    try {
      const spoof = location
        ? await runSpoofChecks(location)
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
        location,
        wifiSsid: null,
        flagReasons: [...spoof.reasons, ...(fence.via === "wifi" ? ["wifi_fallback"] : [])],
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
  const shiftLine = profile.shift_start
    ? `${fmtShiftTime(profile.shift_start)} – ${fmtShiftTime(profile.shift_end ?? "")}`
    : null;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>Namaste, {profile.full_name.split(" ")[0]}</Text>
          <Text style={styles.date}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
            {shiftLine ? ` · ${shiftLine}` : ""}
          </Text>
        </View>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
      </View>

      <View style={[styles.chip, fence.inside ? styles.chipGood : styles.chipNeutral]}>
        <View style={[styles.chipDot, { backgroundColor: fence.inside ? colors.good : colors.ink3 }]} />
        <Text style={[styles.chipText, fence.inside && { color: colors.good }]}>
          {locGranted === false
            ? "Allow location to check in at the shop"
            : fence.inside
              ? "You are at the shop"
              : fence.distance !== null
                ? `You are ${fence.distance} m from the shop`
                : "Finding your location…"}
        </Text>
      </View>

      {data.pending > 0 && (
        <View style={styles.noticeAmber}>
          <Text style={styles.noticeAmberText}>
            {data.pending} check-in{data.pending > 1 ? "s" : ""} saved — will send when internet returns
          </Text>
        </View>
      )}
      {blocked && (
        <Pressable style={styles.noticeRed} onPress={() => setBlocked(null)}>
          <Text style={styles.noticeRedText}>{blocked}</Text>
        </Pressable>
      )}
      {shiftNotice && (
        <View style={styles.noticeAmber}>
          <Text style={styles.noticeAmberText}>{shiftNotice}</Text>
        </View>
      )}

      {/* the one action */}
      <View style={styles.buttonWrap}>
        {dayClosed ? (
          <View style={[styles.bigButton, styles.bigButtonDone]}>
            <Text style={styles.doneTick}>✓</Text>
            <Text style={styles.doneText}>Day complete</Text>
            <Text style={styles.doneSub}>See you tomorrow</Text>
          </View>
        ) : (
          <Animated.View style={{ transform: [{ scale: press }] }}>
            <Pressable
              onPressIn={() =>
                Animated.spring(press, { toValue: 0.95, useNativeDriver: true, speed: 30 }).start()
              }
              onPressOut={() =>
                Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18 }).start()
              }
              onPress={() => stage && punch(stage)}
              disabled={!enabled}
              style={[
                styles.bigButton,
                stage?.tone === "end" ? styles.bigButtonEnd : styles.bigButtonStart,
                enabled ? shadow.button : styles.bigButtonDisabled,
              ]}
            >
              <Text style={[styles.bigButtonText, !enabled && styles.textDisabled]}>
                {stage?.label}
              </Text>
              <Text style={[styles.bigButtonSub, !enabled && styles.textDisabled]}>
                {enabled ? stage?.hint : "Come closer to the shop"}
              </Text>
            </Pressable>
          </Animated.View>
        )}
      </View>

      {/* lunch is a secondary action, never competing with the main one */}
      {canTakeLunch && (
        <Pressable
          style={[styles.lunchBtn, !fence.inside && styles.lunchBtnDisabled]}
          disabled={!fence.inside || busy}
          onPress={() =>
            punch({
              kind: "LUNCH_OUT", direction: "OUT",
              label: "LUNCH", hint: "", tone: "break",
            })
          }
        >
          <Text style={[styles.lunchText, !fence.inside && styles.textDisabled]}>
            Going for lunch break
          </Text>
        </Pressable>
      )}

      <Text style={styles.selfieHint}>
        Your time and location are recorded with every entry
      </Text>

      {/* today's timeline */}
      {punches.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>TODAY</Text>
          {punches.map((p, i) => (
            <View key={i} style={styles.timelineRow}>
              <View
                style={[
                  styles.timelineDot,
                  { backgroundColor: p.direction === "IN" ? colors.good : colors.accent },
                ]}
              />
              <Text style={styles.timelineLabel}>
                {KIND_LABEL[p.punch_kind ?? ""] ?? (p.direction === "IN" ? "Checked in" : "Checked out")}
              </Text>
              <Text style={styles.timelineTime}>{fmtPunch(p.server_ts)}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.tiles}>
        <View style={styles.tile}>
          <Text style={[styles.tileValue, { color: colors.good }]}>{worked}</Text>
          <Text style={styles.tileLabel}>Days present</Text>
        </View>
        <View style={styles.tile}>
          <Text style={[styles.tileValue, absent > 0 && { color: colors.rose }]}>{absent}</Text>
          <Text style={styles.tileLabel}>Days absent</Text>
        </View>
        <View style={styles.tile}>
          <Text style={[styles.tileValue, data.advancePaid > 0 && { color: colors.accent }]}>
            ₹{data.advancePaid.toLocaleString("en-IN")}
          </Text>
          <Text style={styles.tileLabel}>Advance paid</Text>
        </View>
      </View>

      <TouchableOpacity onPress={() => supabase.auth.signOut()}>
        <Text style={styles.logout}>Log out</Text>
      </TouchableOpacity>

      {success && (
        <Animated.View style={[styles.successWrap, { opacity: successAnim }]} pointerEvents="none">
          <Animated.View
            style={[
              styles.successCard,
              shadow.card,
              {
                transform: [{
                  scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
                }],
              },
            ]}
          >
            <View style={styles.successCircle}>
              <Text style={styles.successTick}>✓</Text>
            </View>
            <Text style={styles.successTitle}>{success.title}</Text>
            <Text style={styles.successSub}>{success.sub}</Text>
          </Animated.View>
        </Animated.View>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, paddingTop: 58, paddingBottom: 24 },

  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  greeting: { fontFamily: fonts.black, fontSize: 23, color: colors.ink, letterSpacing: -0.3 },
  date: { fontFamily: fonts.semi, fontSize: 13, color: colors.ink3, marginTop: 2 },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.line,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.extra, fontSize: 17, color: colors.ink2 },

  chip: {
    flexDirection: "row", alignItems: "center", gap: 9,
    borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, marginTop: 16,
  },
  chipGood: { backgroundColor: colors.goodBg },
  chipNeutral: { backgroundColor: "#f3ece1" },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.ink2, flex: 1 },

  noticeAmber: {
    backgroundColor: colors.amberBg, borderRadius: 12, padding: 11, marginTop: 10,
  },
  noticeAmberText: {
    fontFamily: fonts.bold, color: colors.amber, fontSize: 13, textAlign: "center", lineHeight: 18,
  },
  noticeRed: {
    backgroundColor: colors.seriousBg, borderRadius: 12, padding: 11, marginTop: 10,
  },
  noticeRedText: {
    fontFamily: fonts.bold, color: colors.serious, fontSize: 13, textAlign: "center", lineHeight: 18,
  },

  buttonWrap: { alignItems: "center", marginTop: 30, marginBottom: 14 },
  bigButton: {
    width: 208, height: 208, borderRadius: 104,
    alignItems: "center", justifyContent: "center",
  },
  bigButtonStart: { backgroundColor: colors.accent },
  bigButtonEnd: { backgroundColor: colors.good },
  bigButtonDone: { backgroundColor: colors.goodBg },
  bigButtonDisabled: { backgroundColor: colors.line },
  bigButtonText: {
    fontFamily: fonts.black, fontSize: 25, color: "#fff",
    letterSpacing: 0.5, textAlign: "center", lineHeight: 31,
  },
  bigButtonSub: {
    fontFamily: fonts.bold, fontSize: 12.5, color: "rgba(255,255,255,0.85)",
    marginTop: 6, textAlign: "center", paddingHorizontal: 20,
  },
  textDisabled: { color: colors.ink3 },
  doneTick: { fontFamily: fonts.black, fontSize: 44, color: colors.good },
  doneText: { fontFamily: fonts.black, fontSize: 19, color: colors.good, marginTop: 4 },
  doneSub: { fontFamily: fonts.semi, fontSize: 13, color: colors.ink2, marginTop: 2 },

  lunchBtn: {
    alignSelf: "center",
    paddingVertical: 11, paddingHorizontal: 22,
    borderRadius: 999,
    borderWidth: 1.5, borderColor: colors.line2,
    backgroundColor: colors.surface,
    marginBottom: 12,
  },
  lunchBtnDisabled: { opacity: 0.45 },
  lunchText: { fontFamily: fonts.extra, fontSize: 14, color: colors.ink2 },

  selfieHint: {
    fontFamily: fonts.semi, fontSize: 12.5, color: colors.ink3,
    textAlign: "center", paddingHorizontal: 30, lineHeight: 18, marginBottom: 4,
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, padding: 16, marginTop: 16,
  },
  cardLabel: {
    fontFamily: fonts.extra, fontSize: 10.5, color: colors.ink3,
    letterSpacing: 1.2, marginBottom: 10,
  },
  timelineRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  timelineDot: { width: 8, height: 8, borderRadius: 4 },
  timelineLabel: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.ink, flex: 1 },
  timelineTime: { fontFamily: fonts.extra, fontSize: 13.5, color: colors.ink2 },

  tiles: { flexDirection: "row", gap: 8, marginTop: 12 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    borderRadius: 12, paddingVertical: 13, alignItems: "center",
  },
  tileValue: { fontFamily: fonts.black, fontSize: 18, color: colors.ink },
  tileLabel: { fontFamily: fonts.bold, fontSize: 11, color: colors.ink3, marginTop: 2 },

  logout: {
    fontFamily: fonts.bold, textAlign: "center", color: colors.ink3,
    fontSize: 13, padding: 18,
  },

  successWrap: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(58,47,40,0.35)",
  },
  successCard: {
    backgroundColor: colors.surface, borderRadius: 20,
    paddingVertical: 28, paddingHorizontal: 32, alignItems: "center", maxWidth: 300,
  },
  successCircle: {
    width: 68, height: 68, borderRadius: 34, backgroundColor: colors.goodBg,
    alignItems: "center", justifyContent: "center", marginBottom: 12,
  },
  successTick: { fontFamily: fonts.black, fontSize: 32, color: colors.good },
  successTitle: { fontFamily: fonts.black, fontSize: 21, color: colors.ink, textAlign: "center" },
  successSub: {
    fontFamily: fonts.semi, fontSize: 13.5, color: colors.ink2,
    marginTop: 4, textAlign: "center",
  },

  cameraContainer: { flex: 1, backgroundColor: "#241d18" },
  cameraTop: { paddingTop: 58, paddingBottom: 14, alignItems: "center" },
  cameraTitle: { fontFamily: fonts.extra, color: "#fff", fontSize: 16.5 },
  cameraHint: { fontFamily: fonts.semi, color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 3 },
  cameraFrame: { flex: 1, marginHorizontal: 16, borderRadius: 22, overflow: "hidden" },
  camera: { flex: 1 },
  faceGuide: {
    position: "absolute", top: "13%", alignSelf: "center",
    width: 235, height: 295, borderRadius: 150,
    borderWidth: 2.5, borderColor: "rgba(255,255,255,0.6)", borderStyle: "dashed",
  },
  cameraControls: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", padding: 22,
  },
  cancelButton: { width: 76 },
  cancelText: { fontFamily: fonts.bold, color: "rgba(255,255,255,0.8)", fontSize: 15 },
  shutter: {
    width: 74, height: 74, borderRadius: 37, backgroundColor: "#fff",
    alignItems: "center", justifyContent: "center",
  },
  shutterInner: {
    width: 58, height: 58, borderRadius: 29,
    borderWidth: 4, borderColor: colors.accent,
  },
});
