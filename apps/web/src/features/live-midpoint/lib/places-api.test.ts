import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchNearbyVenues } from "./places-api";
import type { LatLng } from "./geo-math";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CENTER: LatLng = { lat: 32.08, lng: 34.78 };

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function errorResponse(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    statusText: `status ${status}`,
    headers: {
      get: (n: string) => (n === "Retry-After" ? (retryAfter ?? null) : null),
    },
    json: () => Promise.resolve({}),
  };
}

const ONE_PLACE = {
  places: [
    {
      id: "p1",
      displayName: { text: "Cafe One" },
      location: { latitude: 32.081, longitude: 34.781 },
      rating: 4.5,
      userRatingCount: 120,
      currentOpeningHours: { openNow: true },
      types: ["cafe"],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_GOOGLE_PLACES_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("searchNearbyVenues", () => {
  it("returns mapped places on success", async () => {
    mockFetch.mockResolvedValue(jsonResponse(ONE_PLACE));

    const result = await searchNearbyVenues(CENTER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.displayName).toBe("Cafe One");
  });

  it("treats an absent API key as a disabled feature, not a failure", async () => {
    vi.stubEnv("VITE_GOOGLE_PLACES_API_KEY", "");

    const result = await searchNearbyVenues(CENTER);

    expect(result).toEqual({ ok: true, value: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns an empty success when the response carries no places", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    const result = await searchNearbyVenues(CENTER);

    expect(result).toEqual({ ok: true, value: [] });
  });

  // Regression: a 429 used to be thrown and then caught by this function's own
  // catch block, so callers received [] and could never back off.
  it("reports a 429 as a distinct RATE_LIMITED failure", async () => {
    mockFetch.mockResolvedValue(errorResponse(429, "30"));

    const result = await searchNearbyVenues(CENTER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "RATE_LIMITED",
      retryAfterMs: 30_000,
    });
  });

  it("defaults retryAfterMs to 0 when the header is missing", async () => {
    mockFetch.mockResolvedValue(errorResponse(429));

    const result = await searchNearbyVenues(CENTER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "RATE_LIMITED", retryAfterMs: 0 });
  });

  it("reports other non-OK statuses as HTTP failures", async () => {
    mockFetch.mockResolvedValue(errorResponse(503));

    const result = await searchNearbyVenues(CENTER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "HTTP", status: 503 });
  });

  it("reports a transport throw as a NETWORK failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await searchNearbyVenues(CENTER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "NETWORK",
      detail: "Failed to fetch",
    });
  });

  // Abort is the caller superseding this call, not a dependency failure — it
  // must stay a throw so the callers' stale-response guards keep working.
  it("re-throws AbortError rather than returning it as a failure", async () => {
    mockFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(searchNearbyVenues(CENTER)).rejects.toThrow("aborted");
  });
});
