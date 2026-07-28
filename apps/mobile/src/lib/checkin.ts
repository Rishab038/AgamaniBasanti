// Check-in orchestration: build the row -> queue -> sync.
// The row goes into the local queue FIRST so a network drop can
// never lose a punch, then we immediately try to drain.
//
// A photo may accompany the arrival punch. It is not an identity check
// — the fingerprint machine does that — it is the tie-breaker for the
// geofence, which cannot always be trusted (weak indoor fix, a tight
// radius, a stale location). It is optional at every step: no photo
// still records a punch.
//
// The image rides in the offline queue as base64 and is uploaded when
// the row syncs, so a punch taken with no signal keeps its photo.

import * as Crypto from "expo-crypto";
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

export async function performCheckin(opts: {
  profileId: string;
  branchId: string;
  direction: "IN" | "OUT";
  punchKind: "ARRIVAL" | "LUNCH_OUT" | "LUNCH_IN" | "DEPARTURE";
  location: LocationObject | null;
  wifiSsid: string | null;
  flagReasons: string[];
  /** base64 JPEG from PhotoCapture, or null when there is no photo */
  photoBase64?: string | null;
}): Promise<{ queued: boolean }> {
  const deviceId = await getDeviceId();
  const now = new Date();

  const photo = opts.photoBase64 ?? null;
  // {uid}/{yyyy-mm}/{epoch}.jpg — the cleanup job reads the age from
  // storage, and the month folder keeps listings small
  const selfiePath = photo
    ? `${opts.profileId}/${now.toISOString().slice(0, 7)}/${now.getTime()}.jpg`
    : null;
  // Hash the bytes we are about to store, so the record can prove the
  // image was not swapped later even after the file itself is deleted.
  const selfieHash = photo
    ? await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, photo)
    : null;

  const row: CheckinRow = {
    profile_id: opts.profileId,
    branch_id: opts.branchId,
    direction: opts.direction,
    punch_kind: opts.punchKind,
    client_ts: now.toISOString(),
    lat: opts.location?.coords.latitude ?? null,
    lng: opts.location?.coords.longitude ?? null,
    accuracy_m: opts.location?.coords.accuracy ?? null,
    wifi_ssid: opts.wifiSsid,
    device_id: deviceId,
    selfie_path: selfiePath,
    selfie_sha256: selfieHash,
    flag: opts.flagReasons.length > 0 ? "SUSPECT" : "CLEAN",
    flag_reasons: opts.flagReasons,
    synced_late: false,
  };

  enqueue(row, photo);
  const synced = await drain();
  return { queued: synced === 0 };
}
