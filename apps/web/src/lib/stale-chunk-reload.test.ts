import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reloadOnStaleChunk,
  STALE_CHUNK_RELOAD_INTERVAL_MS,
} from "./stale-chunk-reload";

const preloadError = () => new Event("vite:preloadError", { cancelable: true });

describe("reloadOnStaleChunk", () => {
  let target: EventTarget;
  let reload: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    target = Object.assign(new EventTarget(), {
      sessionStorage,
      location: { reload },
    });
    uninstall = reloadOnStaleChunk(target as unknown as Window);
  });

  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
  });

  // After a deploy the previous bundle's chunks are gone, and the next lazy
  // import in a tab still running it failed into the error boundary.
  it("reloads, instead of failing, when a chunk from the last deploy is gone", () => {
    const event = preloadError();

    target.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets a chunk that is still missing after the reload fail", () => {
    target.dispatchEvent(preloadError());
    const again = preloadError();

    target.dispatchEvent(again);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(again.defaultPrevented).toBe(false);
  });

  it("reloads again for the next deploy", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    target.dispatchEvent(preloadError());

    now.mockReturnValue(1_000_000 + STALE_CHUNK_RELOAD_INTERVAL_MS);
    target.dispatchEvent(preloadError());

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("lets the error surface when storage is blocked, rather than risk a loop", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const event = preloadError();

    target.dispatchEvent(event);

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
