/**
 * Client-side wrapper for Google Places API (New) — Nearby Search.
 * Uses direct REST calls with API key (CORS-compatible for browser).
 */

import type { LatLng } from "./geo-math";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyResponse, classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
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

export type SearchVenues = (
  center: LatLng,
  radiusMeters: number,
  signal: AbortSignal,
) => Promise<Result<PlaceResult[], ResourceError>>;

/**
 * Bind a Google Places (New) Nearby Search client to a key.
 *
 * The key is supplied by the composition root rather than read from
 * `import.meta.env` here — it was previously read in three places, any of
 * which could disagree about whether the feature was even on.
 *
 * A `null` key is not a failure: venue search is optional and degrades to an
 * empty list by design.
 *
 * Failures are returned, not swallowed. The original implementation threw
 * `RATE_LIMITED` on a 429 and caught it in its own catch block two lines
 * later, returning `[]` — so a caller could not distinguish "no venues near
 * here" from "the API rejected us", and nothing downstream could back off.
 *
 * The returned function takes the search centre, a radius in metres
 * (default 1000) and an AbortSignal, and resolves `PlaceResult[]` ready for
 * ranking or a typed transport failure.
 */
export function createPlacesClient(apiKey: string | null): SearchVenues {
  return async function searchNearbyVenues(
    center: LatLng,
    radiusMeters: number = 1000,
    signal?: AbortSignal,
  ): Promise<Result<PlaceResult[], ResourceError>> {
    if (apiKey === null) return ok([]);

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
        return err(classifyResponse(res));
      }

      const data: PlacesNearbyResponse = await res.json();
      if (!data.places) return ok([]);

      return ok(
        data.places
          .map(mapGooglePlace)
          .filter((p): p is PlaceResult => p !== null),
      );
    } catch (thrown) {
      // Abort is the caller superseding us, not a dependency failure — it must
      // stay a throw so the existing stale-response guards keep working.
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        throw thrown;
      }
      console.warn("[places-api] search failed:", thrown);
      return err(classifyThrown(thrown));
    }
  };
}
