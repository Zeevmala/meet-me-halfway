import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWakeLock } from "./useWakeLock";

interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

function installWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(() => {
    const sentinel: FakeSentinel = {
      released: false,
      release: vi.fn(() => {
        sentinel.released = true;
        return Promise.resolve();
      }),
    };
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
  return { request, sentinels };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  Reflect.deleteProperty(document, "visibilityState");
});

describe("useWakeLock", () => {
  it("holds a screen lock while active and releases it when it stops", async () => {
    const { request, sentinels } = installWakeLock();

    const { rerender } = renderHook(({ active }) => useWakeLock(active), {
      initialProps: { active: true },
    });
    await settle();
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");

    rerender({ active: false });
    expect(sentinels[0]?.release).toHaveBeenCalledOnce();
  });

  it("asks for nothing while inactive", async () => {
    const { request } = installWakeLock();

    renderHook(() => useWakeLock(false));
    await settle();

    expect(request).not.toHaveBeenCalled();
  });

  // The browser drops the lock when the page is hidden and never restores it.
  it("takes the lock again when the page comes back into view", async () => {
    const { request, sentinels } = installWakeLock();
    renderHook(() => useWakeLock(true));
    await settle();

    const first = sentinels[0];
    if (first) first.released = true;
    setVisibility("hidden");
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not ask twice while it still holds the lock", async () => {
    const { request } = installWakeLock();
    renderHook(() => useWakeLock(true));
    await settle();

    setVisibility("visible");
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a lock granted after it was no longer wanted", async () => {
    const { sentinels } = installWakeLock();

    const { unmount } = renderHook(() => useWakeLock(true));
    unmount();
    await settle();

    expect(sentinels[0]?.release).toHaveBeenCalledOnce();
  });

  it("does nothing where the API does not exist", () => {
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it("treats a refusal as no lock, not an error", async () => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(() => Promise.reject(new Error("NotAllowed"))) },
    });

    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
    await settle();
  });
});
