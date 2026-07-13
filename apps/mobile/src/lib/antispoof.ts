// Anti-spoofing signals. Hard failures block the check-in with a
// friendly message; soft signals let it through flagged SUSPECT so
// the owner sees it in the "Needs attention" queue.
//
// The fingerprint machine is the ultimate anchor (cross-verification
// happens in the database) — these checks just raise the bar.

import * as Location from "expo-location";
import * as Network from "expo-network";

export type SpoofResult = {
  hardBlock: boolean; // refuse the check-in outright
  reasons: string[]; // stored on the row as flag_reasons
};

export async function runSpoofChecks(
  loc: Location.LocationObject,
): Promise<SpoofResult> {
  const reasons: string[] = [];
  let hardBlock = false;

  // Android reports fake-GPS apps here — the one non-negotiable
  if (loc.mocked) {
    reasons.push("mock_location");
    hardBlock = true;
  }

  if ((loc.coords.accuracy ?? Infinity) > 150) {
    reasons.push("very_low_gps_accuracy");
  }

  try {
    const net = await Network.getNetworkStateAsync();
    if (net.type === Network.NetworkStateType.VPN) {
      reasons.push("vpn_active");
    }
  } catch {
    // network state unavailable — not a spoof signal by itself
  }

  // TODO (Phase 1, needs expo-dev-client build — not readable in Expo Go):
  //  - Play Integrity API verdict (free tier: 10K requests/day)
  //  - developer-options / USB-debugging enabled check
  //  - rooted-device heuristics

  return { hardBlock, reasons };
}
