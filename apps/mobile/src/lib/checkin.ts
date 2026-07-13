// Check-in orchestration: compress selfie -> hash -> queue -> sync.
// The row goes into the local queue FIRST so a network drop can
// never lose a punch, then we immediately try to drain.

import * as Crypto from "expo-crypto";
import * as ImageManipulator from "expo-image-manipulator";
import type { LocationObject } from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CheckinRow, drain, enqueue } from "./queue";

const DEVICE_ID_KEY = "agamani.device_id";

/**
 * Stable per-install ID used for device binding. A reinstall makes
 * a new one, which the owner must re-approve — acceptable friction.
 */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Resize to 720px wide, ~50 KB JPEG, return base64 for hashing/upload. */
async function compressSelfie(uri: string): Promise<string> {
  // TODO Phase 1: burn the watermark (name/time/coords) into the
  // image with react-native-view-shot before this compression step.
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 720 } }],
    { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );
  if (!result.base64) throw new Error("selfie compression produced no data");
  return result.base64;
}

export async function performCheckin(opts: {
  profileId: string;
  branchId: string;
  direction: "IN" | "OUT";
  location: LocationObject | null;
  wifiSsid: string | null;
  selfieUri: string;
  flagReasons: string[];
}): Promise<{ queued: boolean }> {
  const deviceId = await getDeviceId();
  const selfieBase64 = await compressSelfie(opts.selfieUri);
  const sha256 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    selfieBase64,
  );

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const selfiePath = `${opts.profileId}/${month}/${now.getTime()}.jpg`;

  const row: CheckinRow = {
    profile_id: opts.profileId,
    branch_id: opts.branchId,
    direction: opts.direction,
    client_ts: now.toISOString(),
    lat: opts.location?.coords.latitude ?? null,
    lng: opts.location?.coords.longitude ?? null,
    accuracy_m: opts.location?.coords.accuracy ?? null,
    wifi_ssid: opts.wifiSsid,
    device_id: deviceId,
    selfie_path: selfiePath,
    selfie_sha256: sha256,
    flag: opts.flagReasons.length > 0 ? "SUSPECT" : "CLEAN",
    flag_reasons: opts.flagReasons,
    synced_late: false,
  };

  enqueue(row, selfieBase64);
  const synced = await drain();
  return { queued: synced === 0 };
}
