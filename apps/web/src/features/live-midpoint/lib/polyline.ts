/**
 * Route geometry as it travels between devices: Google's encoded polyline,
 * at precision 5 (1e-5°, about a metre).
 *
 * Each device routes its own trip and publishes it for the others to draw
 * (`sessions/{code}/trips/{slot}`). GeoJSON for a simplified route is a few
 * hundred coordinate pairs of fifteen-digit floats; the same line encoded is
 * a string about a fifth of that, with a precision no screen can tell from
 * the original. Precision 5 rather than 6: the metre is already finer than
 * the line drawn on the map.
 *
 * Coordinates are GeoJSON `[lng, lat]` on both sides; the encoding itself
 * stores latitude first, as the algorithm defines it.
 */
import type * as GeoJSON from "geojson";

const FACTOR = 1e5;

/**
 * The longest encoded line the rules accept. A route of thousands of points
 * still fits; one that does not is simplified until it does.
 */
export const MAX_LINE_LENGTH = 20_000;

/** The most points a decoded line may hold; more is not a route we wrote. */
const MAX_POINTS = 10_000;

/** The characters an encoded polyline is made of: `?` (63) to `~` (126). */
const ENCODED = /^[?-~]*$/;

function encodeValue(value: number, out: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

/** Encode `[lng, lat]` positions. */
export function encodePolyline(
  coordinates: readonly GeoJSON.Position[],
): string {
  const out: string[] = [];
  let lastLat = 0;
  let lastLng = 0;
  for (const position of coordinates) {
    const lng = Math.round((position[0] ?? 0) * FACTOR);
    const lat = Math.round((position[1] ?? 0) * FACTOR);
    encodeValue(lat - lastLat, out);
    encodeValue(lng - lastLng, out);
    lastLat = lat;
    lastLng = lng;
  }
  return out.join("");
}

/**
 * Decode to `[lng, lat]` positions, or `null` for anything that is not a
 * well-formed line: the string comes from another device, through rules that
 * check its alphabet and length but cannot check that it decodes.
 */
export function decodePolyline(encoded: string): GeoJSON.Position[] | null {
  if (!ENCODED.test(encoded)) return null;
  const points: GeoJSON.Position[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length || shift > 30) return null;
      const b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return null;
    lat += dLat;
    lng += dLng;
    const position: GeoJSON.Position = [lng / FACTOR, lat / FACTOR];
    if (Math.abs(position[1] ?? 0) > 90 || Math.abs(position[0] ?? 0) > 180) {
      return null;
    }
    points.push(position);
    if (points.length > MAX_POINTS) return null;
  }
  return points.length >= 2 ? points : null;
}

/**
 * Douglas–Peucker on an equirectangular projection about the line's first
 * point, which is exact enough over the length of a trip.
 */
export function simplifyLine(
  coordinates: readonly GeoJSON.Position[],
  toleranceM: number,
): GeoJSON.Position[] {
  if (coordinates.length <= 2) return coordinates.slice();
  const lat0 = ((coordinates[0]?.[1] ?? 0) * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = mPerDegLat * Math.cos(lat0);
  const xy = coordinates.map((p) => [
    (p[0] ?? 0) * mPerDegLng,
    (p[1] ?? 0) * mPerDegLat,
  ]);

  const keep = new Uint8Array(coordinates.length);
  keep[0] = 1;
  keep[coordinates.length - 1] = 1;
  const stack: [number, number][] = [[0, coordinates.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    const [first, last] = span;
    const [ax = 0, ay = 0] = xy[first] ?? [];
    const [bx = 0, by = 0] = xy[last] ?? [];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    let farthest = -1;
    let farthestDist = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const [px = 0, py = 0] = xy[i] ?? [];
      let dist: number;
      if (lengthSq === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(
          0,
          Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq),
        );
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist > farthestDist) {
        farthest = i;
        farthestDist = dist;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return coordinates.filter((_, i) => keep[i] === 1);
}

/**
 * The line to publish: as fetched when it fits, else simplified — a few
 * metres at a time, doubling — until it does.
 */
export function encodeRouteLine(
  geometry: GeoJSON.LineString,
  maxLength: number = MAX_LINE_LENGTH,
): string {
  let coordinates: readonly GeoJSON.Position[] = geometry.coordinates;
  let encoded = encodePolyline(coordinates);
  for (let toleranceM = 5; encoded.length > maxLength; toleranceM *= 2) {
    coordinates = simplifyLine(coordinates, toleranceM);
    encoded = encodePolyline(coordinates);
    if (coordinates.length <= 2) break;
  }
  return encoded;
}
