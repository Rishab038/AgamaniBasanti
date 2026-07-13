// Worker home: one giant button. Enabled only inside the geofence
// (or on shop Wi-Fi); otherwise grey with a plain-language distance
// message. Tap -> selfie -> queued locally -> synced.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import { CameraView, useCameraPermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Branch, Profile, supabase } from "../lib/supabase";
import { evaluateFence, FenceResult } from "../lib/geofence";
import { runSpoofChecks } from "../lib/antispoof";
import { performCheckin } from "../lib/checkin";
import { drain, pendingCount } from "../lib/queue";

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
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [locGranted, setLocGranted] = useState<boolean | null>(null);
  const cameraRef = useRef<CameraView>(null);

  // today's punch direction toggles IN -> OUT (offline-safe)
  useEffect(() => {
    AsyncStorage.getItem(LAST_DIRECTION_KEY).then((v) => {
      const [day, dir] = (v ?? "").split("|");
      if (day === new Date().toDateString() && dir === "IN") setDirection("OUT");
    });
  }, []);

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

  const startCheckin = async () => {
    if (!camPerm?.granted) {
      const p = await requestCamPerm();
      if (!p.granted) {
        Alert.alert("Camera needed", "Attendance needs a selfie. Please allow the camera.");
        return;
      }
    }
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
        Alert.alert(
          "Check-in blocked",
          "Location problem detected. Please switch off any fake-location app and try again.",
        );
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

      await AsyncStorage.setItem(
        LAST_DIRECTION_KEY,
        `${new Date().toDateString()}|${direction}`,
      );
      setDirection(direction === "IN" ? "OUT" : "IN");
      setPending(pendingCount());
      setCameraOpen(false);
      Alert.alert(
        direction === "IN" ? "Checked in!" : "Checked out!",
        queued
          ? "No internet right now — saved on the phone, will send automatically."
          : "Done. Have a good day!",
      );
    } catch (e) {
      Alert.alert("Something went wrong", "Please try again in a minute.");
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const buttonEnabled = fence.inside && !busy;

  return (
    <View style={styles.container}>
      <Text style={styles.greeting}>Hello, {profile.full_name}</Text>
      <Text style={styles.date}>{new Date().toDateString()}</Text>

      {pending > 0 && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingText}>
            {pending} check-in{pending > 1 ? "s" : ""} waiting for internet
          </Text>
        </View>
      )}

      <View style={styles.center}>
        <TouchableOpacity
          style={[
            styles.bigButton,
            direction === "OUT" && styles.bigButtonOut,
            !buttonEnabled && styles.bigButtonDisabled,
          ]}
          disabled={!buttonEnabled}
          onPress={startCheckin}
        >
          <Text style={styles.bigButtonText}>
            {direction === "IN" ? "CHECK IN" : "CHECK OUT"}
          </Text>
        </TouchableOpacity>

        {locGranted === false && (
          <Text style={styles.hint}>
            Please allow location — attendance only works at the shop.
          </Text>
        )}
        {locGranted && !fence.inside && (
          <Text style={styles.hint}>
            {fence.distance !== null
              ? `You are ${fence.distance} m from the shop. Come closer to check in.`
              : "Finding your location…"}
          </Text>
        )}
        {fence.inside && (
          <Text style={[styles.hint, styles.hintOk]}>
            You are at the shop {fence.via === "wifi" ? "(shop Wi-Fi)" : ""}
          </Text>
        )}
      </View>

      <TouchableOpacity onPress={() => supabase.auth.signOut()}>
        <Text style={styles.logout}>Log out</Text>
      </TouchableOpacity>

      <Modal visible={cameraOpen} animationType="slide">
        <View style={styles.cameraContainer}>
          <CameraView ref={cameraRef} style={styles.camera} facing="front" />
          <View style={styles.cameraControls}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setCameraOpen(false)}
              disabled={busy}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.shutter} onPress={capture} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.shutterText}>📸</Text>}
            </TouchableOpacity>
            <View style={{ width: 80 }} />
          </View>
          <Text style={styles.cameraHint}>Take a clear selfie to confirm attendance</Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", padding: 24, paddingTop: 64 },
  greeting: { fontSize: 26, fontWeight: "700", color: "#1a1a2e" },
  date: { fontSize: 16, color: "#666", marginTop: 4 },
  pendingBanner: {
    backgroundColor: "#fdf3d8",
    borderRadius: 10,
    padding: 12,
    marginTop: 16,
  },
  pendingText: { color: "#8a6d1a", fontSize: 15, textAlign: "center" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  bigButton: {
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "#16a085",
    justifyContent: "center",
    alignItems: "center",
    elevation: 6,
  },
  bigButtonOut: { backgroundColor: "#e67e22" },
  bigButtonDisabled: { backgroundColor: "#bbb", elevation: 0 },
  bigButtonText: { color: "#fff", fontSize: 30, fontWeight: "800" },
  hint: { fontSize: 17, color: "#666", textAlign: "center", marginTop: 24, paddingHorizontal: 12 },
  hintOk: { color: "#16a085", fontWeight: "600" },
  logout: { textAlign: "center", color: "#999", fontSize: 15, padding: 8 },
  cameraContainer: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  cameraControls: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 24,
  },
  cancelButton: { width: 80 },
  cancelText: { color: "#fff", fontSize: 18 },
  shutter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#16a085",
    justifyContent: "center",
    alignItems: "center",
  },
  shutterText: { fontSize: 32 },
  cameraHint: { color: "#fff", textAlign: "center", paddingBottom: 32, fontSize: 16 },
});
