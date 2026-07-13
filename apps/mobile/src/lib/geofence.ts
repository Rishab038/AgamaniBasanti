// Geofence math. GPS is the primary gate; the registered shop
// Wi-Fi is the indoor fallback when accuracy is poor (Phase 1:
// SSID read needs @react-native-community/netinfo in a dev build).

const EARTH_RADIUS_M = 6371000;

export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

export type FenceResult = {
  inside: boolean;
  distance: number | null; // meters from shop, null when branch has no coords yet
  via: "gps" | "wifi" | "none";
};

export function evaluateFence(opts: {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  branchLat: number | null;
  branchLng: number | null;
  radiusM: number;
  currentSsid: string | null;
  branchSsid: string | null;
}): FenceResult {
  const {
    lat, lng, accuracy, branchLat, branchLng, radiusM, currentSsid, branchSsid,
  } = opts;

  if (lat !== null && lng !== null && branchLat !== null && branchLng !== null) {
    const d = distanceMeters(lat, lng, branchLat, branchLng);
    // With poor accuracy, give the benefit of the doubt only up to
    // the fence edge — beyond that, fall through to Wi-Fi.
    const effective = Math.max(0, d - Math.min(accuracy ?? 0, radiusM));
    if (effective <= radiusM) return { inside: true, distance: d, via: "gps" };
    if (branchSsid && currentSsid === branchSsid) {
      return { inside: true, distance: d, via: "wifi" };
    }
    return { inside: false, distance: d, via: "none" };
  }

  if (branchSsid && currentSsid === branchSsid) {
    return { inside: true, distance: null, via: "wifi" };
  }
  return { inside: false, distance: null, via: "none" };
}
