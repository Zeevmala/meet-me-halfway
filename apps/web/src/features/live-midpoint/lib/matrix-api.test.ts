import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMatrixClient, MATRIX_MAX_COORDINATES } from "./matrix-api";
import type { LatLng } from "./geo-math";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const A: LatLng = { lat: 32.08, lng: 34.78 };
const B: LatLng = { lat: 31.77, lng: 35.21 };
const C1: LatLng = { lat: 31.9, lng: 35.0 };
const C2: LatLng = { lat: 31.95, lng: 34.9 };

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("createMatrixClient", () => {
  const fetchMatrix = createMatrixClient("tok");
  const signal = new AbortController().signal;

  it("asks for durations from every source to every destination", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        code: "Ok",
        durations: [
          [10, 20],
          [30, 40],
        ],
      }),
    );

    await fetchMatrix([A, B], [C1, C2], "driving", signal);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain(
      "/directions-matrix/v1/mapbox/driving/" +
        "34.780000,32.080000;35.210000,31.770000;" +
        "35.000000,31.900000;34.900000,31.950000?",
    );
    expect(url).toContain("sources=0;1");
    expect(url).toContain("destinations=2;3");
    expect(url).toContain("annotations=duration");
  });

  it("returns the durations and each destination as snapped to a road", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        code: "Ok",
        durations: [
          [10, null],
          [30, 40],
        ],
        destinations: [{ location: [35.001, 31.901] }, null],
      }),
    );

    const result = await fetchMatrix([A, B], [C1, C2], "walking", signal);

    expect(result).toEqual({
      ok: true,
      value: {
        durations: [
          [10, null],
          [30, 40],
        ],
        // The second was not reported, so it stays where it was asked for.
        snapped: [{ lat: 31.901, lng: 35.001 }, C2],
      },
    });
  });

  it("refuses a body whose matrix is not the shape asked for", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ code: "Ok", durations: [[10, 20]] }),
    );

    const result = await fetchMatrix([A, B], [C1, C2], "driving", signal);

    expect(result).toEqual({ ok: false, error: { kind: "HTTP", status: 502 } });
  });

  it("classifies a rate limit", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
    });

    const result = await fetchMatrix([A], [C1], "driving", signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RATE_LIMITED");
  });

  it("makes no request it knows Mapbox would refuse", async () => {
    const tooMany = new Array<LatLng>(MATRIX_MAX_COORDINATES).fill(C1);

    const result = await fetchMatrix([A], tooMany, "driving", signal);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: { kind: "HTTP", status: 422 } });
  });

  it("lets an abort through as an abort", async () => {
    mockFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(fetchMatrix([A], [C1], "driving", signal)).rejects.toThrow(
      "aborted",
    );
  });
});
