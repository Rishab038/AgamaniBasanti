// Worker home: one giant button. Enabled only inside the geofence
// (or on shop Wi-Fi); otherwise grey with a plain-language distance
// message. Tap -> selfie -> queued locally -> synced.
// Motion: pulse ring invites the tap, spring on press, animated
// success overlay + haptics make a punch feel done.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { CameraView, useCameraPermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Branch, Profile, supabase } from "../lib/supabase";
import { evaluateFence, FenceResult } from "../lib/geofence";
import { runSpoofChecks } from "../lib/antispoof";
import { performCheckin } from "../lib/checkin";
import { drain, pendingCount } from "../lib/queue";
import { colors, radius, shadow } from "../lib/theme";

const LAST_DIRECTION_KEY = "agamani.last_direction";

export default function HomeScreen({
  profile,
  branch,
}: {
  profile: Profile;
  branch: Branch;
}) {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [fence, setFence] = useState<FenceResult>({ inside: false, distance: null, via: "none" });
  const [direction, setDirection] = useState<"IN" | "OUT">("IN");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [lastPunch, setLastPunch] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const cameraRef = useRef<CameraView>(null);

  const pulse = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  const enabled = fence.inside && !busy;

  // today's punch direction toggles IN -> OUT (offline-safe)
  useEffect(() => {
    AsyncStorage.getItem(LAST_DIRECTION_KEY).then((v) => {
      const [day, dir, time] = (v ?? "").split("|");
      if (day === new Date().toDateString()) {
        if (dir === "IN") setDirection("OUT");
        if (time) setLastPunch(`${dir === "IN" ? "Checked in" : "Checked out"} at ${time}`);
      }
    });
  }, []);

  // inviting pulse ring while the button is live
  useEffect(() => {
    if (!enabled) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [enabled, pulse]);

  // watch GPS while the app is open
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

  // drain the offline queue whenever the screen mounts
  useEffect(() => {
    setPending(pendingCount());
    drain().then(() => setPending(pendingCount()));
  }, []);

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    successAnim.setValue(0);
    Animated.sequence([
      Animated.spring(successAnim, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }),
      Animated.delay(1600),
      Animated.timing(successAnim, { toValue: 0, duration: 260, useNativeDriver: true }),
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

      const time = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      await AsyncStorage.setItem(
        LAST_DIRECTION_KEY,
        `${new Date().toDateString()}|${direction}|${time}`,
      );
      setLastPunch(`${direction === "IN" ? "Checked in" : "Checked out"} at ${time}`);
      setDirection(direction === "IN" ? "OUT" : "IN");
      setPending(pendingCount());
      setCameraOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showSuccess(
        queued
          ? "Saved on phone — will send when internet returns"
          : direction === "IN" ? "Checked in. Have a good day!" : "Checked out. See you tomorrow!",
      );
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCameraOpen(false);
      setBlocked("Something went wrong. Please try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.35, 0.12, 0] });
  const isOut = direction === "OUT";

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hello, {profile.full_name.split(" ")[0]}</Text>
          <Text style={styles.date}>
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
          </Text>
        </View>
        <View style={[styles.dot, { backgroundColor: fence.inside ? colors.good : colors.ink3 }]} />
      </View>

      {pending > 0 && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingText}>
            ⏳ {pending} check-in{pending > 1 ? "s" : ""} waiting for internet — will send automatically
          </Text>
        </View>
      )}
      {blocked && (
        <Pressable style={styles.blockedBanner} onPress={() => setBlocked(null)}>
          <Text style={styles.blockedText}>{blocked}</Text>
        </Pressable>
      )}

      {lastPunch && (
        <View style={[styles.statusCard, shadow.card]}>
          <Text style={styles.statusLabel}>TODAY</Text>
          <Text style={styles.statusValue}>{lastPunch}</Text>
        </View>
      )}

      <View style={styles.center}>
        <View style={styles.buttonStack}>
          {enabled && (
            <Animated.View
              style={[
                styles.pulseRing,
                { backgroundColor: isOut ? colors.out : colors.brand },
                { opacity: pulseOpacity, transform: [{ scale: pulseScale }] },
              ]}
            />
          )}
          <Animated.View style={{ transform: [{ scale: press }] }}>
            <Pressable
              onPressIn={() =>
                Animated.spring(press, { toValue: 0.94, useNativeDriver: true, speed: 30 }).start()
              }
              onPressOut={() =>
                Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 20 }).start()
              }
              onPress={startCheckin}
              disabled={!enabled}
              style={[
                styles.bigButton,
                shadow.button,
                { backgroundColor: isOut ? colors.out : colors.brand },
                !enabled && styles.bigButtonDisabled,
              ]}
            >
              <Text style={styles.bigButtonText}>{isOut ? "CHECK\nOUT" : "CHECK\nIN"}</Text>
            </Pressable>
          </Animated.View>
        </View>

        {locGranted === false && (
          <Text style={styles.hint}>Please allow location — attendance only works at the shop.</Text>
        )}
        {locGranted && !fence.inside && (
          <Text style={styles.hint}>
            {fence.distance !== null
              ? `You are ${fence.distance} m from the shop.\nCome closer to check in.`
              : "Finding your location…"}
          </Text>
        )}
        {fence.inside && (
          <Text style={[styles.hint, styles.hintOk]}>
            ✓ You are at the shop{fence.via === "wifi" ? " (shop Wi-Fi)" : ""}
          </Text>
        )}
      </View>

      <TouchableOpacity onPress={() => supabase.auth.signOut()}>
        <Text style={styles.logout}>Log out</Text>
      </TouchableOpacity>

      {/* success overlay */}
      {success && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.successWrap,
            {
              opacity: successAnim,
              transform: [{
                scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
              }],
            },
          ]}
        >
          <View style={[styles.successCard, shadow.card]}>
            <View style={styles.successCircle}>
              <Text style={styles.successTick}>✓</Text>
            </View>
            <Text style={styles.successText}>{success}</Text>
          </View>
        </Animated.View>
      )}

      <Modal visible={cameraOpen} animationType="slide">
        <View style={styles.cameraContainer}>
          <View style={styles.cameraTop}>
            <Text style={styles.cameraHint}>Take a clear selfie to confirm it's you</Text>
          </View>
          <CameraView ref={cameraRef} style={styles.camera} facing="front" />
          <View style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setCameraOpen(false)}
              disabled={busy}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Pressable
              style={({ pressed }) => [styles.shutter, pressed && { transform: [{ scale: 0.92 }] }]}
              onPress={capture}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color={colors.brand} />
                : <View style={styles.shutterInner} />}
            </Pressable>
            <View style={{ width: 80 }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 22, paddingTop: 64 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  greeting: { fontSize: 26, fontWeight: "800", color: colors.ink, letterSpacing: -0.4 },
  date: { fontSize: 15, color: colors.ink3, marginTop: 3 },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 10 },

  pendingBanner: {
    backgroundColor: colors.warnBg,
    borderRadius: radius.md,
    padding: 13,
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#fde8c0",
  },
  pendingText: { color: colors.warn, fontSize: 14, textAlign: "center", fontWeight: "500" },
  blockedBanner: {
    backgroundColor: colors.seriousBg,
    borderRadius: radius.md,
    padding: 13,
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#fde3e1",
  },
  blockedText: { color: colors.serious, fontSize: 14, textAlign: "center", fontWeight: "500" },

  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    marginTop: 18,
  },
  statusLabel: { fontSize: 11.5, fontWeight: "700", color: colors.ink3, letterSpacing: 1 },
  statusValue: { fontSize: 17, fontWeight: "600", color: colors.ink, marginTop: 3 },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  buttonStack: { width: 250, height: 250, alignItems: "center", justifyContent: "center" },
  pulseRing: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
  },
  bigButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    justifyContent: "center",
    alignItems: "center",
  },
  bigButtonDisabled: {
    backgroundColor: "#c3ccd4",
    shadowOpacity: 0,
    elevation: 0,
  },
  bigButtonText: {
    color: "#fff",
    fontSize: 32,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 40,
    letterSpacing: 0.5,
  },
  hint: {
    fontSize: 16,
    color: colors.ink2,
    textAlign: "center",
    marginTop: 26,
    paddingHorizontal: 12,
    lineHeight: 23,
  },
  hintOk: { color: colors.good, fontWeight: "600" },
  logout: { textAlign: "center", color: colors.ink3, fontSize: 14, padding: 10 },

  successWrap: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 28,
    paddingHorizontal: 30,
    alignItems: "center",
    maxWidth: 300,
    borderWidth: 1,
    borderColor: colors.line,
  },
  successCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.goodBg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  successTick: { fontSize: 32, color: colors.good, fontWeight: "800" },
  successText: { fontSize: 16, fontWeight: "600", color: colors.ink, textAlign: "center" },

  cameraContainer: { flex: 1, backgroundColor: "#000" },
  cameraTop: { paddingTop: 64, paddingBottom: 16, alignItems: "center" },
  cameraHint: { color: "#fff", fontSize: 16, fontWeight: "500" },
  camera: { flex: 1, borderRadius: 24, overflow: "hidden", marginHorizontal: 14 },
  cameraControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 26,
  },
  cancelButton: { width: 80 },
  cancelText: { color: "#fff", fontSize: 17 },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 4,
    borderColor: colors.brand,
  },
  logoutHidden: { display: "none" },
});
