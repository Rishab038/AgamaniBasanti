// The check-in photo.
//
// Purpose is narrow: when the GPS radius is in doubt — a weak indoor
// fix, a tight fence, a stale location — the owner needs something
// better than a coordinate to settle whether someone was really at the
// shop. It is not a second identity check; the fingerprint machine does
// that. So this stays as light as possible: front camera, one tap, no
// review screen, no retake, and the image is gone in two days.
//
// It must never be able to block attendance. Camera broken, permission
// refused, shutter fails — the punch still goes through without a photo.

import { useRef, useState } from "react";
import {
  ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { colors, fonts, radius } from "../lib/theme";

export type Shot = { base64: string; sha256: null };

/** Downscale before upload — shop wifi is not fast. A check-in photo is
 *  evidence of a face being in a place, so it can go small; a bill has
 *  to stay readable, so callers ask for more width and less crushing. */
async function shrink(uri: string, width: number): Promise<string | null> {
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width } }],
      {
        compress: width > 900 ? 0.7 : 0.5,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      },
    );
    return out.base64 ?? null;
  } catch {
    return null;
  }
}

export default function PhotoCapture({
  visible,
  onDone,
  onCancel,
  facing = "front",
  hint = "Face the camera and tap the circle",
  askTitle = "Photo at check-in",
  askBody = "A quick photo shows you were at the shop if the location check is unclear. It is deleted after 2 days.",
  skipLabel = "Check in without a photo",
  allowSkip = true,
  width = 640,
}: {
  visible: boolean;
  /** base64 of the shot, or null when it could not be taken */
  onDone: (base64: string | null) => void;
  onCancel: () => void;
  /** "back" for documents like a bill, "front" for the person */
  facing?: "front" | "back";
  hint?: string;
  askTitle?: string;
  askBody?: string;
  skipLabel?: string;
  /** a bill photo is the evidence behind a debt, so it cannot be skipped */
  allowSkip?: boolean;
  /** a bill has to stay readable, so it is resized less aggressively */
  width?: number;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const cam = useRef<CameraView>(null);

  const snap = async () => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      // skipProcessing keeps the shutter quick on low-end phones; the
      // orientation it skips does not matter for a presence check
      const pic = await cam.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
      onDone(pic?.uri ? await shrink(pic.uri, width) : null);
    } catch {
      onDone(null);        // never strand the worker on a camera fault
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  // Permission not decided yet — ask, with the reason in plain words.
  if (!permission?.granted) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.backdrop}>
          <View style={styles.askCard}>
            <Text style={styles.askTitle}>{askTitle}</Text>
            <Text style={styles.askBody}>{askBody}</Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={async () => {
                const res = await requestPermission();
                if (!res.granted) onDone(null);   // carry on without one
              }}
            >
              <Text style={styles.primaryText}>Allow camera</Text>
            </TouchableOpacity>
            {allowSkip && (
              <TouchableOpacity style={styles.skipBtn} onPress={() => onDone(null)}>
                <Text style={styles.skipText}>{skipLabel}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.root}>
        <CameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          facing={facing}
          onCameraReady={() => setReady(true)}
        />
        <View style={styles.top}>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <View style={styles.bottom}>
          <TouchableOpacity onPress={onCancel} style={styles.side}>
            <Text style={styles.sideText}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={snap}
            disabled={!ready || busy}
            style={[styles.shutter, (!ready || busy) && styles.shutterOff]}
          >
            {busy ? <ActivityIndicator color={colors.accent} /> : <View style={styles.shutterDot} />}
          </TouchableOpacity>

          {allowSkip ? (
            <TouchableOpacity onPress={() => onDone(null)} style={styles.side}>
              <Text style={styles.sideText}>Skip</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.side} />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  top: { position: "absolute", top: 60, left: 0, right: 0, alignItems: "center" },
  hint: {
    fontFamily: fonts.bold, fontSize: 15, color: "#fff",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.lg,
  },
  bottom: {
    position: "absolute", bottom: 48, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-around",
  },
  side: { padding: 14, minWidth: 84, alignItems: "center" },
  sideText: { fontFamily: fonts.bold, fontSize: 15, color: "#fff" },
  shutter: {
    width: 78, height: 78, borderRadius: 39,
    borderWidth: 4, borderColor: "#fff",
    alignItems: "center", justifyContent: "center",
  },
  shutterOff: { opacity: 0.4 },
  shutterDot: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#fff" },

  backdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  askCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: 22, width: "100%", maxWidth: 380, gap: 12,
  },
  askTitle: { fontFamily: fonts.extra, fontSize: 19, color: colors.ink },
  askBody: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.ink2 },
  primaryBtn: {
    backgroundColor: colors.accent, borderRadius: radius.md,
    paddingVertical: 14, alignItems: "center", marginTop: 4,
  },
  primaryText: { fontFamily: fonts.bold, fontSize: 16, color: "#fff" },
  skipBtn: { paddingVertical: 10, alignItems: "center" },
  skipText: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink3 },
});
