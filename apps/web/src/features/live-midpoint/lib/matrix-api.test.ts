import { describe, it, expect, vi, afterEach } from "vitest";
import { createMatrixClient } from "./matrix-api";
import type { LatLng } from "./geo-math";

const A: LatLng = { lat: 32.08, lng: 34.78 };
const B: LatLng = { lat: 31.77, lng: 35.21 };
const C1: LatLng = { lat: 31.9, lng: 35.0 };
const C2: LatLng = { lat: 31.95, lng: 34.95 };

const signal = new AbortController().signal;

function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("createMatrixClient", () => {
  it("asks for durations from every source to every destination, lng first", async () => {
    const fetchMock = respond({
      code: "Ok",
      durations: [
        [600, 700],
        [800, 500],
      ],
      destinations: [
        { location: [35.001, 31.901] },
        { location: [34.95, 31.95] },
      ],
    });

    const result = await createMatrixClient("tok")(
      [A, B],
      [C1, C2],
      "driving",
      signal,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(
      "/directions-matrix/v1/mapbox/driving/" +
        "34.780000,32.080000;35.210000,31.770000;" +
        "35.000000,31.900000;34.950000,31.950000",
    );
    expect(url.searchParams.get("sources")).toBe("0;1");
    expect(url.searchParams.get("destinations")).toBe("2;3");
    expect(url.searchParams.get("annotations")).toBe("duration");

    expect(result).toEqual({
      ok: true,
      value: {
        durations: [
          [600, 700],
          [800, 500],
        ],
        // The router's snapped location, not the coordinate that was asked.
        destinations: [
          { lat: 31.901, lng: 35.001 },
          { lat: 31.95, lng: 34.95 },
        ],
      },
    });
  });

  it("classifies a rate limit so the resource can back off", async () => {
    respond({ message: "Too Many Requests" }, 429);
    const result = await createMatrixClient("tok")(
      [A],
      [C1],
      "walking",
      signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("RATE_LIMITED");
  });

  it("refuses a body that is not the matrix that was asked for", async () => {
    respond({ code: "Ok", durations: [[600]], destinations: [] });
    const result = await createMatrixClient("tok")(
      [A],
      [C1],
      "driving",
      signal,
    );
    expect(result).toEqual({ ok: false, error: { kind: "HTTP", status: 422 } });
  });

  it("refuses an answer whose code is not Ok", async () => {
    respond({ code: "NoRoute", durations: [[null]], destinations: [{}] });
    const result = await createMatrixClient("tok")(
      [A],
      [C1],
      "driving",
      signal,
    );
    expect(result.ok).toBe(false);
  });

  it("makes no request it knows the API would refuse", async () => {
    const fetchMock = respond({});
    const tooMany = Array.from({ length: 25 }, () => C1);
    const result = await createMatrixClient("tok")(
      [A],
      tooMany,
      "driving",
      signal,
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows an abort, which is the caller superseding itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    );
    await expect(
      createMatrixClient("tok")([A], [C1], "driving", signal),
    ).rejects.toThrow("Aborted");
  });

  it("returns a transport failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const result = await createMatrixClient("tok")(
      [A],
      [C1],
      "driving",
      signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("NETWORK");
  });
});
