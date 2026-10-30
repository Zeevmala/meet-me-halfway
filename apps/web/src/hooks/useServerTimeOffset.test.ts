import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerTimeOffset } from "./useServerTimeOffset";

let onValueCallback: ((snap: { val: () => unknown }) => void) | null = null;
const mockOnValue = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock("firebase/database", () => ({
  onValue: (r: unknown, onSnap: (snap: { val: () => unknown }) => void) => {
    mockOnValue(r);
    onValueCallback = onSnap;
    return mockUnsubscribe;
  },
  ref: (_db: unknown, path?: string) => ({ path }),
}));

// Read inside the accessor, so a case can swap in a promise it settles by hand.
let appCheckReady: Promise<unknown>;
vi.mock("./useFirebase", () => ({
  useFirebase: () => ({ app: {}, db: {}, appCheckReady }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  onValueCallback = null;
  appCheckReady = Promise.resolve({ ok: true, reason: "token", latencyMs: 12 });
});

async function mount() {
  const rendered = renderHook(() => useServerTimeOffset());
  await act(async () => {});
  return rendered;
}

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("useServerTimeOffset", () => {
  it("assumes no offset until the server has reported one", async () => {
    const { result } = await mount();

    expect(result.current).toBe(0);
  });

  it("reports the offset RTDB measured, and follows it as it changes", async () => {
    const { result } = await mount();
    expect(mockOnValue).toHaveBeenCalledWith({
      path: ".info/serverTimeOffset",
    });

    act(() => onValueCallback?.({ val: () => -95_000 }));
    expect(result.current).toBe(-95_000);

    // Re-measured on reconnect.
    act(() => onValueCallback?.({ val: () => 1_200 }));
    expect(result.current).toBe(1_200);
  });

  it("treats a value that is not a number as no offset", async () => {
    const { result } = await mount();

    act(() => onValueCallback?.({ val: () => -95_000 }));
    act(() => onValueCallback?.({ val: () => null }));

    expect(result.current).toBe(0);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = await mount();

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  // Subscribing opens the RTDB socket, which carries the App Check token it
  // had when it connected — none, if this ran first.
  it("does not subscribe before attestation settles", async () => {
    const gate = deferred();
    appCheckReady = gate.promise;

    renderHook(() => useServerTimeOffset());
    await act(async () => {});
    expect(mockOnValue).not.toHaveBeenCalled();

    await act(async () => gate.settle());
    expect(mockOnValue).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe at all if unmounted while attestation is pending", async () => {
    const gate = deferred();
    appCheckReady = gate.promise;

    const { unmount } = renderHook(() => useServerTimeOffset());
    unmount();
    await act(async () => gate.settle());

    expect(mockOnValue).not.toHaveBeenCalled();
  });
});
