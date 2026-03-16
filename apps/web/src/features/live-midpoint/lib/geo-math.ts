/**
 * Client-side spherical geodesic midpoint and haversine distance.
 * Pure math on WGS84 sphere approximation — no external deps.
 * Sufficient for typical meetup distances (<200 km, error <1 m vs ellipsoidal).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_000; // Earth mean radius in meters
const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Spherical midpoint of two points on the great circle. */
export function sphericalMidpoint(a: LatLng, b: LatLng): LatLng {
  const phi1 = toRad(a.lat);
  const lam1 = toRad(a.lng);
  const phi2 = toRad(b.lat);
  const dLam = toRad(b.lng - a.lng);

  const Bx = Math.cos(phi2) * Math.cos(dLam);
  const By = Math.cos(phi2) * Math.sin(dLam);

  const phiM = Math.atan2(
    Math.sin(phi1) + Math.sin(phi2),
    Math.sqrt((Math.cos(phi1) + Bx) ** 2 + By ** 2),
  );
  const lamM = lam1 + Math.atan2(By, Math.cos(phi1) + Bx);

  return { lat: toDeg(phiM), lng: toDeg(lamM) };
}

/** Haversine distance in meters between two WGS84 points. */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const dPhi = toRad(b.lat - a.lat);
  const dLam = toRad(b.lng - a.lng);
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Format meters as "1.2 km" or "450 m". */
export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}
