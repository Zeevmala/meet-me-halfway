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

/**
 * Geographic centroid of N points using Cartesian mean.
 * Converts each lat/lng to 3D unit-sphere coordinates, averages,
 * then converts back. Gives the spherical "center of mass".
 */
export function geographicCentroid(points: LatLng[]): LatLng {
  if (points.length === 0) {
    throw new Error("geographicCentroid requires at least one point");
  }
  if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };

  let x = 0;
  let y = 0;
  let z = 0;

  for (const p of points) {
    const phi = toRad(p.lat);
    const lam = toRad(p.lng);
    x += Math.cos(phi) * Math.cos(lam);
    y += Math.cos(phi) * Math.sin(lam);
    z += Math.sin(phi);
  }

  x /= points.length;
  y /= points.length;
  z /= points.length;

  const lng = Math.atan2(y, x);
  const hyp = Math.sqrt(x * x + y * y);
  const lat = Math.atan2(z, hyp);

  return { lat: toDeg(lat), lng: toDeg(lng) };
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

/**
 * Generate a GeoJSON Polygon circle centered on a WGS84 point.
 * Uses the spherical direct formula for geodesically accurate radii.
 *
 * @param center - Circle center in WGS84 (EPSG:4326)
 * @param radiusMeters - Circle radius in meters
 * @param steps - Number of polygon vertices (default 64)
 * @returns GeoJSON Polygon in [lng, lat] coordinate order
 */
export function accuracyCircleGeoJSON(
  center: LatLng,
  radiusMeters: number,
  steps: number = 64,
): GeoJSON.Polygon {
  const coords: [number, number][] = [];
  const lat1 = toRad(center.lat);
  const lng1 = toRad(center.lng);
  const angularDist = radiusMeters / R;

  for (let i = 0; i < steps; i++) {
    const bearing = toRad((360 / steps) * i);

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDist) +
        Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
        Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2),
      );

    coords.push([toDeg(lng2), toDeg(lat2)]);
  }

  // Close the ring
  coords.push(coords[0]);

  return {
    type: "Polygon",
    coordinates: [coords],
  };
}
