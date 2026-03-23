/**
 * Client-side wrapper for Google Places API (New) — Nearby Search.
 * Uses direct REST calls with API key (CORS-compatible for browser).
 */

import type { LatLng } from "./geo-math";
import type { PlaceResult } from "./venue-ranking";

const PLACES_API_URL = "https://places.googleapis.com/v1/places:searchNearby";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.currentOpeningHours",
  "places.types",
  "places.formattedAddress",
].join(",");

const VENUE_TYPES = [
  "restaurant",
  "cafe",
  "bar",
  "coffee_shop",
  "bakery",
  "ice_cream_shop",
] as const;

/** Raw Google Places API response shape (subset we need). */
interface GooglePlace {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  currentOpeningHours?: { openNow?: boolean };
  types?: string[];
  formattedAddress?: string;
}

interface PlacesNearbyResponse {
  places?: GooglePlace[];
}

function mapGooglePlace(gp: GooglePlace): PlaceResult | null {
  if (!gp.id || !gp.location?.latitude || !gp.location?.longitude) {
    return null;
  }

  return {
    id: gp.id,
    displayName: gp.displayName?.text ?? "Unknown",
    location: { lat: gp.location.latitude, lng: gp.location.longitude },
    rating: gp.rating ?? 0,
    userRatingCount: gp.userRatingCount ?? 0,
    openNow: gp.currentOpeningHours?.openNow ?? false,
    types: gp.types ?? [],
    formattedAddress: gp.formattedAddress,
  };
}

/**
 * Search for nearby venues using Google Places API (New).
 *
 * @param center - Search center (the midpoint)
 * @param radiusMeters - Search radius (default 1000)
 * @param signal - AbortSignal for request cancellation
 * @returns PlaceResult[] ready for ranking, or [] on error
 */
export async function searchNearbyVenues(
  center: LatLng,
  radiusMeters: number = 1000,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  const apiKey = import.meta.env.VITE_GOOGLE_PLACES_API_KEY as
    | string
    | undefined;
  if (!apiKey) return [];

  try {
    const res = await fetch(PLACES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        locationRestriction: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radiusMeters,
          },
        },
        includedTypes: [...VENUE_TYPES],
        maxResultCount: 20,
      }),
      signal,
    });

    if (!res.ok) {
      console.warn(`[places-api] HTTP ${res.status}: ${res.statusText}`);
      return [];
    }

    const data: PlacesNearbyResponse = await res.json();
    if (!data.places) return [];

    return data.places
      .map(mapGooglePlace)
      .filter((p): p is PlaceResult => p !== null);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("[places-api] search failed:", err);
    return [];
  }
}
