// Home tab — straight from the mockup: greeting + shift, geofence
// chip, one giant round button, selfie hint, three stat tiles.

import { useEffect, useRef, useState } from "react";
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
import { CameraView, useCameraPermissions } from "expo-camera";
import { Branch, Profile, supabase } from "../../lib/supabase";
import { evaluateFence, FenceResult } from "../../lib/geofence";
import { runSpoofChecks } from "../../lib/antispoof";
import { performCheckin } from "../../lib/checkin";
import { pendingCount } from "../../lib/queue";
import { colors, fonts, radius, shadow } from "../../lib/theme";
import type { SharedData } from "../MainScreen";

const fmtShiftTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")}`;
};

const fmtClock = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

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
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [success, setSuccess] = useState<{ title: string; sub: string } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const press = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  const punches = data.todayPunches;
  const direction: "IN" | "OUT" =
    punches.length > 0 && punches[punches.length - 1].direction === "IN" ? "OUT" : "IN";
  const isOut = direction === "OUT";
  const enabled = fence.inside && !busy;

  // month numbers for the stat tiles. Salary is deliberately absent:
  // showing a running estimate invites payday arguments when it does not
  // match the owner's final figure.
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
              currentSsid: null, // Phase 1: netinfo SSID in dev build
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
      showSuccess(
        direction === "IN" ? "Checked in!" : "Checked out!",
        queued
          ? "Saved on your phone — sends when internet returns"
          : `at ${fmtClock(new Date())} · selfie saved`,
      );
      await data.reload();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCameraOpen(false);
      setBlocked("Something went wrong. Please try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  const initials = profile.full_name.trim()[0]?.toUpperCase() ?? "?";
  const shiftLine = data.shift
    ? ` · Shift ${fmtShiftTime(data.shift.start_time)} – ${fmtShiftTime(data.shift.end_time)}`
    : "";

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      {/* greeting */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>Namaste, {profile.full_name.split(" ")[0]}</Text>
          <Text style={styles.date}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
            {shiftLine}
          </Text>
        </View>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
      </View>

      {/* geofence chip */}
      <View style={[styles.chip, fence.inside ? styles.chipGood : styles.chipNeutral]}>
        <View style={[styles.chipDot, { backgroundColor: fence.inside ? colors.good : colors.ink3 }]} />
        <Text style={[styles.chipText, fence.inside && { color: colors.good }]}>
          {locGranted === false
            ? "Allow location to check in at the shop"
            : fence.inside
              ? `You are at the shop — ready to check ${isOut ? "out" : "in"}`
              : fence.distance !== null
                ? `You are ${fence.distance} m from the shop`
                : "Finding your location…"}
        </Text>
      </View>

      {data.pending > 0 && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingText}>
            {data.pending} check-in{data.pending > 1 ? "s" : ""} saved — will send when internet returns
          </Text>
        </View>
      )}
      {blocked && (
        <Pressable style={styles.blockedBanner} onPress={() => setBlocked(null)}>
          <Text style={styles.blockedText}>{blocked}</Text>
        </Pressable>
      )}

      {/* the button */}
      <View style={styles.buttonWrap}>
        <Animated.View style={{ transform: [{ scale: press }] }}>
          <Pressable
            onPressIn={() =>
              Animated.spring(press, { toValue: 0.95, useNativeDriver: true, speed: 30 }).start()
            }
            onPressOut={() =>
              Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18 }).start()
            }
            onPress={startCheckin}
            disabled={!enabled}
            style={[
              styles.bigButton,
              isOut ? styles.bigButtonOut : null,
              enabled ? (isOut ? shadow.buttonGood : shadow.button) : styles.bigButtonDisabled,
            ]}
          >
            <Text style={[styles.bigButtonText, !enabled && styles.bigButtonTextDisabled]}>
              {isOut ? "CHECK OUT" : "CHECK IN"}
            </Text>
            <Text style={[styles.bigButtonSub, !enabled && styles.bigButtonTextDisabled]}>
              {enabled ? "Tap once, then take selfie" : "Come closer to the shop"}
            </Text>
          </Pressable>
        </Animated.View>
      </View>

      <Text style={styles.selfieHint}>
        A selfie with time & location stamp will be saved automatically
      </Text>

      {/* stat tiles */}
      <View style={styles.tiles}>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, { color: colors.good }]}>{worked}</Text>
          <Text style={styles.tileLabel}>Days present</Text>
        </View>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, absent > 0 && { color: colors.rose }]}>{absent}</Text>
          <Text style={styles.tileLabel}>Days absent</Text>
        </View>
        <View style={[styles.tile, shadow.card]}>
          <Text style={[styles.tileValue, data.advancePaid > 0 && { color: colors.accent }]}>
            ₹{data.advancePaid.toLocaleString("en-IN")}
          </Text>
          <Text style={styles.tileLabel}>Advance paid</Text>
        </View>
      </View>

      <TouchableOpacity onPress={() => supabase.auth.signOut()}>
        <Text style={styles.logout}>Log out</Text>
      </TouchableOpacity>

      {/* success overlay */}
      {success && (
        <Animated.View style={[styles.successWrap, { opacity: successAnim }]} pointerEvents="none">
          <Animated.View
            style={[
              styles.successCard,
              shadow.card,
              {
                transform: [{
                  scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
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

      {/* camera */}
      <Modal visible={cameraOpen} animationType="slide">
        <View style={styles.cameraContainer}>
          <View style={styles.cameraTop}>
            <Text style={styles.cameraTitle}>
              {isOut ? "Checking out" : "Checking in"} · {fmtClock(new Date())}
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
                ? <ActivityIndicator color={colors.accent} />
                : <View style={styles.shutterInner} />}
            </Pressable>
            <View style={{ width: 76 }} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 22, paddingTop: 62, paddingBottom: 26 },

  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  greeting: { fontFamily: fonts.black, fontSize: 26, color: colors.ink, letterSpacing: -0.4 },
  date: { fontFamily: fonts.semi, fontSize: 13.5, color: colors.ink3, marginTop: 2 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.extra, fontSize: 18, color: colors.ink2 },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginTop: 20,
  },
  chipGood: { backgroundColor: colors.goodBg },
  chipNeutral: { backgroundColor: "#f3ece1" },
  chipDot: { width: 9, height: 9, borderRadius: 5 },
  chipText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink2, flex: 1 },

  pendingBanner: {
    backgroundColor: colors.amberBg,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 12,
  },
  pendingText: { fontFamily: fonts.bold, color: colors.amber, fontSize: 13, textAlign: "center" },
  blockedBanner: {
    backgroundColor: colors.seriousBg,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 12,
  },
  blockedText: { fontFamily: fonts.bold, color: colors.serious, fontSize: 13, textAlign: "center" },

  buttonWrap: { alignItems: "center", marginTop: 34, marginBottom: 18 },
  bigButton: {
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 6,
    borderBottomColor: "rgba(58,47,40,0.18)",
  },
  bigButtonOut: { backgroundColor: colors.good },
  bigButtonDisabled: {
    backgroundColor: colors.line,
    borderBottomColor: "rgba(58,47,40,0.06)",
  },
  bigButtonText: { fontFamily: fonts.black, fontSize: 27, color: "#fff", letterSpacing: 0.5 },
  bigButtonSub: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: "rgba(255,255,255,0.85)",
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: "center",
  },
  bigButtonTextDisabled: { color: colors.ink3 },

  selfieHint: {
    fontFamily: fonts.semi,
    fontSize: 13,
    color: colors.ink3,
    textAlign: "center",
    paddingHorizontal: 30,
    lineHeight: 19,
  },

  tiles: { flexDirection: "row", gap: 10, marginTop: 24 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingVertical: 16,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  tileValue: { fontFamily: fonts.black, fontSize: 19, color: colors.ink },
  tileLabel: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.ink3, marginTop: 3 },

  logout: {
    fontFamily: fonts.bold,
    textAlign: "center",
    color: colors.ink3,
    fontSize: 13,
    padding: 16,
    marginTop: 4,
  },

  successWrap: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(58,47,40,0.35)",
  },
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 30,
    paddingHorizontal: 34,
    alignItems: "center",
    maxWidth: 300,
  },
  successCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: colors.goodBg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  successTick: { fontFamily: fonts.black, fontSize: 36, color: colors.good },
  successTitle: { fontFamily: fonts.black, fontSize: 23, color: colors.ink },
  successSub: {
    fontFamily: fonts.semi,
    fontSize: 14,
    color: colors.ink2,
    marginTop: 5,
    textAlign: "center",
  },

  cameraContainer: { flex: 1, backgroundColor: "#241d18" },
  cameraTop: { paddingTop: 60, paddingBottom: 16, alignItems: "center" },
  cameraTitle: { fontFamily: fonts.extra, color: "#fff", fontSize: 17 },
  cameraHint: { fontFamily: fonts.semi, color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 3 },
  cameraFrame: { flex: 1, marginHorizontal: 16, borderRadius: radius.lg, overflow: "hidden" },
  camera: { flex: 1 },
  faceGuide: {
    position: "absolute",
    top: "13%",
    alignSelf: "center",
    width: 235,
    height: 295,
    borderRadius: 150,
    borderWidth: 2.5,
    borderColor: "rgba(255,255,255,0.6)",
    borderStyle: "dashed",
  },
  cameraControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 24,
  },
  cancelButton: { width: 76 },
  cancelText: { fontFamily: fonts.bold, color: "rgba(255,255,255,0.8)", fontSize: 15 },
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
    borderColor: colors.accent,
  },
});
