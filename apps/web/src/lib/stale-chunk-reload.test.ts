import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Component,
  Suspense,
  createElement,
  lazy,
  type ComponentType,
  type ReactNode,
} from "react";
import { act, render, screen } from "@testing-library/react";
import {
  pendingWhileReloading,
  reloadOnStaleChunk,
  STALE_CHUNK_RELOAD_INTERVAL_MS,
} from "./stale-chunk-reload";

const preloadError = () => new Event("vite:preloadError", { cancelable: true });

describe("reloadOnStaleChunk", () => {
  let target: EventTarget;
  let reload: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  /** The page the reload loads installs the handler afresh; session storage survives it. */
  const reloadPage = () => {
    uninstall();
    uninstall = reloadOnStaleChunk(target as unknown as Window);
  };

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

  // The page's own chunk has a stylesheet: Vite reports the stylesheet, then
  // the script. The second, left to throw, put the error screen up while the
  // reload the first had asked for was loading.
  it("cancels every later failure in the page it is reloading", () => {
    target.dispatchEvent(preloadError());
    const script = preloadError();

    target.dispatchEvent(script);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(script.defaultPrevented).toBe(true);
  });

  it("lets a chunk that is still missing after the reload fail", () => {
    target.dispatchEvent(preloadError());
    reloadPage();
    const again = preloadError();

    target.dispatchEvent(again);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(again.defaultPrevented).toBe(false);
  });

  it("reloads again for the next deploy", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    target.dispatchEvent(preloadError());
    reloadPage();

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

describe("pendingWhileReloading", () => {
  class Boundary extends Component<
    { children: ReactNode },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed ? "error screen" : this.props.children;
    }
  }

  type Chunk = { default: ComponentType };

  /** Renders `lazy(load)` the way main.tsx does: under Suspense, under an error boundary. */
  function renderLazy(load: () => Promise<Chunk>) {
    const Lazy = lazy(load);
    return render(
      createElement(
        Boundary,
        null,
        createElement(Suspense, { fallback: "loading" }, createElement(Lazy)),
      ),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // What Vite hands back once the reload has cancelled the failed import.
  // React.lazy read `.default` off it: the error screen, and a report to
  // Sentry, for as long as the reload took, in every tab a deploy reloaded.
  it("keeps the loading state up while the reload loads, not the error screen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cancelled = (): Promise<Chunk> => Promise.resolve(undefined as never);
    const { container } = renderLazy(pendingWhileReloading(cancelled));

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container.textContent).toBe("loading");
  });

  it("renders a chunk that loaded", async () => {
    const page = () => createElement("p", null, "page");
    const { container } = renderLazy(
      pendingWhileReloading(() => Promise.resolve({ default: page })),
    );

    await screen.findByText("page");
    expect(container.textContent).toBe("page");
  });

  // Throttled, or with storage blocked, nothing cancels the failure, and it
  // has to reach the error boundary as the error it is.
  it("lets a failure nobody cancelled through to the error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = renderLazy(
      pendingWhileReloading(() => Promise.reject(new Error("chunk missing"))),
    );

    await screen.findByText("error screen");
    expect(container.textContent).toBe("error screen");
  });
});
