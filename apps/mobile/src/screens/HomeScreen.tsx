// Worker home — a personal day hub, not a punch card.
// Live clock, glowing check-in button, today's punch timeline, and
// month stats. Enabled only inside the geofence; otherwise the
// button locks with a plain-language distance message.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
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
import { LinearGradient } from "expo-linear-gradient";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Branch, Profile, supabase } from "../lib/supabase";
import { evaluateFence, FenceResult } from "../lib/geofence";
import { runSpoofChecks } from "../lib/antispoof";
import { performCheckin } from "../lib/checkin";
import { drain, pendingCount } from "../lib/queue";
import { colors, gradients, radius, shadow } from "../lib/theme";

type Punch = { direction: "IN" | "OUT"; server_ts: string };
type MonthStats = { worked: number; late: number; absent: number };

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtClock = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const fmtPunch = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export default function HomeScreen({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [now, setNow] = useState(new Date());
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [fence, setFence] = useState<FenceResult>({ inside: false, distance: null, via: "none" });
  const [punches, setPunches] = useState<Punch[]>([]);
  const [stats, setStats] = useState<MonthStats | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(0);
  const [success, setSuccess] = useState<{ title: string; sub: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const cameraRef = useRef<CameraView>(null);

  const pulse = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  // direction derives from today's punch history: next is IN unless last was IN
  const direction: "IN" | "OUT" =
    punches.length > 0 && punches[punches.length - 1].direction === "IN" ? "OUT" : "IN";
  const isOut = direction === "OUT";
  const enabled = fence.inside && !busy;

  // ---- live clock ----
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- server data: today's punches + month stats ----
  const loadDay = useCallback(async () => {
    try {
      const dayStartUtc = new Date(`${istToday()}T00:00:00+05:30`).toISOString();
      const monthStartIst = `${istToday().slice(0, 7)}-01`;
      const [p, d] = await Promise.all([
        supabase
          .from("attendance_app")
          .select("direction, server_ts")
          .eq("profile_id", profile.id)
          .gte("server_ts", dayStartUtc)
          .order("server_ts"),
        supabase
          .from("attendance_days")
          .select("status, late_minutes")
          .eq("profile_id", profile.id)
          .gte("work_date", monthStartIst),
      ]);
      if (p.data) setPunches(p.data as Punch[]);
      if (d.data) {
        setStats({
          worked: d.data.filter((r) =>
            ["VERIFIED", "APP_ONLY", "DEVICE_ONLY"].includes(r.status),
          ).length,
          late: d.data.filter((r) => r.late_minutes > 0).length,
          absent: d.data.filter((r) => r.status === "ABSENT").length,
        });
      }
    } catch {
      // offline — keep whatever we have
    }
    setPending(pendingCount());
  }, [profile.id]);

  useEffect(() => {
    drain().then(loadDay);
  }, [loadDay]);

  const onRefresh = async () => {
    setRefreshing(true);
    await drain();
    await loadDay();
    setRefreshing(false);
  };

  // ---- pulse halo while live ----
  useEffect(() => {
    if (!enabled) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [enabled, pulse]);

  // ---- GPS watch ----
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
              currentSsid: null, // Phase 1: netinfo SSID in dev build
              branchSsid: branch.wifi_ssid,
            }),
          );
        },
      );
    })();
    return () => sub?.remove();
  }, [branch]);

  const showSuccess = (title: string, sub: string) => {
    setSuccess({ title, sub });
    successAnim.setValue(0);
    Animated.sequence([
      Animated.spring(successAnim, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 9 }),
      Animated.delay(1900),
      Animated.timing(successAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start(() => setSuccess(null));
  };

  const startCheckin = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!camPerm?.granted) {
      const p = await requestCamPerm();
      if (!p.granted) {
        setBlocked("Attendance needs a selfie. Please allow the camera and try again.");
        return;
      }
    }
    setBlocked(null);
    setCameraOpen(true);
  };

  const capture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const spoof = location
        ? await runSpoofChecks(location)
        : { hardBlock: false, reasons: ["no_gps_fix"] };
      if (spoof.hardBlock) {
        setCameraOpen(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setBlocked("Location problem detected. Switch off any fake-location app and try again.");
        return;
      }

      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      const { queued } = await performCheckin({
        profileId: profile.id,
        branchId: branch.id,
        direction,
        location,
        wifiSsid: null,
        selfieUri: photo.uri,
        flagReasons: [...spoof.reasons, ...(fence.via === "wifi" ? ["wifi_fallback"] : [])],
      });

      setCameraOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // optimistic timeline update; server refresh follows
      setPunches((prev) => [...prev, { direction, server_ts: new Date().toISOString() }]);
      showSuccess(
        direction === "IN" ? "Checked in" : "Checked out",
        queued
          ? "Saved on your phone — sends when internet returns"
          : `at ${fmtClock(new Date())} · verified with selfie`,
      );
      loadDay();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCameraOpen(false);
      setBlocked("Something went wrong. Please try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.3, 0.1, 0] });
  const initials = profile.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <LinearGradient colors={gradients.screen} style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
        }
      >
        {/* header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View>
              <Text style={styles.greeting}>Hi, {profile.full_name.split(" ")[0]}</Text>
              <Text style={styles.date}>
                {now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
              </Text>
            </View>
          </View>
          <View
            style={[
              styles.fenceChip,
              { borderColor: fence.inside ? "rgba(74,222,128,0.4)" : colors.cardBorder },
            ]}
          >
            <View
              style={[styles.fenceDot, { backgroundColor: fence.inside ? colors.good : colors.ink3 }]}
            />
            <Text style={[styles.fenceText, fence.inside && { color: colors.good }]}>
              {fence.inside ? "At shop" : "Away"}
            </Text>
          </View>
        </View>

        {pending > 0 && (
          <View style={styles.pendingBanner}>
            <Text style={styles.pendingText}>
              {pending} check-in{pending > 1 ? "s" : ""} waiting for internet — sends automatically
            </Text>
          </View>
        )}
        {blocked && (
          <Pressable style={styles.blockedBanner} onPress={() => setBlocked(null)}>
            <Text style={styles.blockedText}>{blocked}</Text>
          </Pressable>
        )}

        {/* live clock */}
        <View style={styles.clockWrap}>
          <Text style={styles.clock}>{fmtClock(now)}</Text>
          <Text style={styles.clockSub}>
            {locGranted === false
              ? "Allow location to check in at the shop"
              : fence.inside
                ? `You're at ${branch.name} — ready when you are`
                : fence.distance !== null
                  ? `${fence.distance} m from the shop`
                  : "Finding your location…"}
          </Text>
        </View>

        {/* the button */}
        <View style={styles.buttonStack}>
          {enabled && (
            <Animated.View
              style={[
                styles.halo,
                { backgroundColor: isOut ? colors.out : colors.brand },
                { opacity: pulseOpacity, transform: [{ scale: pulseScale }] },
              ]}
            />
          )}
          <Animated.View style={{ transform: [{ scale: press }] }}>
            <Pressable
              onPressIn={() =>
                Animated.spring(press, { toValue: 0.93, useNativeDriver: true, speed: 30 }).start()
              }
              onPressOut={() =>
                Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18 }).start()
              }
              onPress={startCheckin}
              disabled={!enabled}
            >
              <LinearGradient
                colors={
                  enabled
                    ? (isOut ? gradients.checkout : gradients.checkin)
                    : (["#232e48", "#1a2338"] as const)
                }
                style={[styles.bigButton, enabled && (isOut ? shadow.glowOrange : shadow.glowTeal)]}
              >
                <Text style={[styles.bigButtonText, !enabled && { color: colors.ink3 }]}>
                  {isOut ? "CHECK\nOUT" : "CHECK\nIN"}
                </Text>
                <Text style={[styles.bigButtonSub, !enabled && { color: colors.ink3 }]}>
                  {enabled ? "tap to take selfie" : "come closer to the shop"}
                </Text>
              </LinearGradient>
            </Pressable>
          </Animated.View>
        </View>

        {/* today timeline */}
        <View style={[styles.cardBlock, shadow.card]}>
          <Text style={styles.cardTitle}>TODAY</Text>
          {punches.length === 0 ? (
            <Text style={styles.emptyText}>No punches yet — your day starts here.</Text>
          ) : (
            punches.map((p, i) => (
              <View key={i} style={styles.timelineRow}>
                <View style={styles.timelineRail}>
                  <View
                    style={[
                      styles.timelineDot,
                      { backgroundColor: p.direction === "IN" ? colors.brand : colors.out },
                    ]}
                  />
                  {i < punches.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <Text style={styles.timelineLabel}>
                  {p.direction === "IN" ? "Checked in" : "Checked out"}
                </Text>
                <Text style={styles.timelineTime}>{fmtPunch(p.server_ts)}</Text>
              </View>
            ))
          )}
        </View>

        {/* month stats */}
        {stats && (
          <View style={styles.statsRow}>
            <View style={[styles.statChip, shadow.card]}>
              <Text style={[styles.statValue, { color: colors.good }]}>{stats.worked}</Text>
              <Text style={styles.statLabel}>days worked</Text>
            </View>
            <View style={[styles.statChip, shadow.card]}>
              <Text style={[styles.statValue, { color: colors.warn }]}>{stats.late}</Text>
              <Text style={styles.statLabel}>late days</Text>
            </View>
            <View style={[styles.statChip, shadow.card]}>
              <Text style={[styles.statValue, { color: colors.serious }]}>{stats.absent}</Text>
              <Text style={styles.statLabel}>absent</Text>
            </View>
          </View>
        )}

        <TouchableOpacity onPress={() => supabase.auth.signOut()}>
          <Text style={styles.logout}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* success takeover */}
      {success && (
        <Animated.View style={[styles.successWrap, { opacity: successAnim }]} pointerEvents="none">
          <LinearGradient colors={gradients.success} style={styles.successFill}>
            <Animated.View
              style={{
                alignItems: "center",
                transform: [{
                  scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }),
                }],
              }}
            >
              <View style={[styles.successCircle, shadow.glowTeal]}>
                <Text style={styles.successTick}>✓</Text>
              </View>
              <Text style={styles.successTitle}>{success.title}</Text>
              <Text style={styles.successSub}>{success.sub}</Text>
            </Animated.View>
          </LinearGradient>
        </Animated.View>
      )}

      {/* camera */}
      <Modal visible={cameraOpen} animationType="slide">
        <View style={styles.cameraContainer}>
          <View style={styles.cameraTop}>
            <Text style={styles.cameraTitle}>
              {isOut ? "Checking out" : "Checking in"} · {fmtClock(now)}
            </Text>
            <Text style={styles.cameraHint}>Keep your face inside the circle</Text>
          </View>
          <View style={styles.cameraFrame}>
            <CameraView ref={cameraRef} style={styles.camera} facing="front" />
            <View pointerEvents="none" style={styles.faceGuide} />
          </View>
          <View style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setCameraOpen(false)}
              disabled={busy}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Pressable
              style={({ pressed }) => [styles.shutter, pressed && { transform: [{ scale: 0.9 }] }]}
              onPress={capture}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color={colors.brandDeep} />
                : <View style={styles.shutterInner} />}
            </Pressable>
            <View style={{ width: 76 }} />
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 22, paddingTop: 62, paddingBottom: 30 },

  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.brand, fontWeight: "800", fontSize: 16 },
  greeting: { color: colors.ink, fontSize: 19, fontWeight: "800", letterSpacing: -0.3 },
  date: { color: colors.ink3, fontSize: 13, marginTop: 1 },
  fenceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 11,
    backgroundColor: colors.card,
  },
  fenceDot: { width: 7, height: 7, borderRadius: 4 },
  fenceText: { color: colors.ink3, fontSize: 12.5, fontWeight: "600" },

  pendingBanner: {
    backgroundColor: "rgba(251,191,36,0.09)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.25)",
    borderRadius: radius.md,
    padding: 12,
    marginTop: 18,
  },
  pendingText: { color: colors.warn, fontSize: 13.5, textAlign: "center", fontWeight: "500" },
  blockedBanner: {
    backgroundColor: "rgba(248,113,113,0.09)",
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.28)",
    borderRadius: radius.md,
    padding: 12,
    marginTop: 18,
  },
  blockedText: { color: colors.serious, fontSize: 13.5, textAlign: "center", fontWeight: "500" },

  clockWrap: { alignItems: "center", marginTop: 34 },
  clock: {
    color: colors.ink,
    fontSize: 54,
    fontWeight: "800",
    letterSpacing: -1,
    fontVariant: ["tabular-nums"],
  },
  clockSub: { color: colors.ink2, fontSize: 14.5, marginTop: 4, textAlign: "center" },

  buttonStack: {
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 34,
    height: 236,
  },
  halo: { position: "absolute", width: 216, height: 216, borderRadius: 108 },
  bigButton: {
    width: 216,
    height: 216,
    borderRadius: 108,
    alignItems: "center",
    justifyContent: "center",
  },
  bigButtonText: {
    color: "#fff",
    fontSize: 31,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 38,
    letterSpacing: 1,
  },
  bigButtonSub: { color: "rgba(255,255,255,0.75)", fontSize: 12.5, marginTop: 8, fontWeight: "600" },

  cardBlock: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.lg,
    padding: 20,
  },
  cardTitle: { color: colors.ink3, fontSize: 11.5, fontWeight: "800", letterSpacing: 1.4, marginBottom: 12 },
  emptyText: { color: colors.ink2, fontSize: 14.5 },
  timelineRow: { flexDirection: "row", alignItems: "flex-start", minHeight: 34 },
  timelineRail: { width: 20, alignItems: "center" },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  timelineLine: { flex: 1, width: 2, backgroundColor: colors.cardBorder, marginVertical: 3 },
  timelineLabel: { color: colors.ink, fontSize: 15, fontWeight: "600", flex: 1, marginLeft: 8 },
  timelineTime: { color: colors.ink2, fontSize: 14, fontVariant: ["tabular-nums"] },

  statsRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  statChip: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  statValue: { fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] },
  statLabel: { color: colors.ink3, fontSize: 11.5, marginTop: 2, fontWeight: "600" },

  logout: { textAlign: "center", color: colors.ink3, fontSize: 13.5, padding: 16, marginTop: 6 },

  successWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  successFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  successCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: colors.brandDeep,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  successTick: { fontSize: 44, color: "#fff", fontWeight: "800" },
  successTitle: { color: colors.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.4 },
  successSub: { color: colors.ink2, fontSize: 15, marginTop: 6, textAlign: "center", paddingHorizontal: 30 },

  cameraContainer: { flex: 1, backgroundColor: colors.bg },
  cameraTop: { paddingTop: 62, paddingBottom: 18, alignItems: "center" },
  cameraTitle: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  cameraHint: { color: colors.ink2, fontSize: 13.5, marginTop: 3 },
  cameraFrame: { flex: 1, marginHorizontal: 16, borderRadius: radius.xl, overflow: "hidden" },
  camera: { flex: 1 },
  faceGuide: {
    position: "absolute",
    top: "14%",
    alignSelf: "center",
    width: 240,
    height: 300,
    borderRadius: 150,
    borderWidth: 2.5,
    borderColor: "rgba(255,255,255,0.55)",
    borderStyle: "dashed",
  },
  cameraControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 24,
  },
  cancelButton: { width: 76 },
  cancelText: { color: colors.ink2, fontSize: 16 },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 4,
    borderColor: colors.brandDeep,
  },
});
