// Check-in orchestration: build the row -> queue -> sync.
// The row goes into the local queue FIRST so a network drop can
// never lose a punch, then we immediately try to drain.
//
// No selfie is captured. The fingerprint machine is the proof that a
// person was physically present; the app supplies the geofenced
// timestamp, device binding and anti-spoof signals. Requiring both
// sources for a VERIFIED day is the two-step check, so a photo added
// friction and a privacy burden without adding evidence.

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
}): Promise<{ queued: boolean }> {
  const deviceId = await getDeviceId();
  const now = new Date();

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
    selfie_path: null,
    selfie_sha256: null,
    flag: opts.flagReasons.length > 0 ? "SUSPECT" : "CLEAN",
    flag_reasons: opts.flagReasons,
    synced_late: false,
  };

  enqueue(row, null);
  const synced = await drain();
  return { queued: synced === 0 };
}
