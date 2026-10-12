import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, act } from "@testing-library/react";
import { ServicesProvider } from "../../components/ServicesProvider";
import type { Services } from "../../lib/services";
import type { GraphPorts } from "./graph/ports";
import LiveMidpointPage from "./LiveMidpointPage";
import { ok } from "../../core/dag/result";

/**
 * The page as `main.tsx` mounts it — inside <StrictMode> — with the *real*
 * geolocation hook. LiveMidpointPage.test.tsx mocks that hook and renders
 * without StrictMode, which is why neither suite ever saw `npm run dev` kill
 * the GPS watch on mount and abort the session handshake.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ status: "authenticated", uid: "test-uid" }),
}));
vi.mock("../../hooks/useNetworkStatus", () => ({
  useNetworkStatus: () => ({ isOnline: true }),
}));

const { mockCreateSession, mockJoinSession } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockJoinSession: vi.fn(),
}));
vi.mock("./hooks/useLiveSession", () => ({
  useLiveSession: () => ({
    status: "ready",
    code: "ABC234",
    ownIndex: 0,
    ownName: "Me",
    participants: [],
    error: null,
    errorDetails: null,
    creatorUid: "test-uid",
    createSession: mockCreateSession,
    joinSession: mockJoinSession,
    setOwnName: vi.fn(),
    cleanup: vi.fn(),
  }),
}));
vi.mock("./components/LiveMap", () => ({ default: () => <div /> }));
vi.mock("./components/SessionBadge", () => ({ default: () => <div /> }));
vi.mock("./components/WaitingCard", () => ({ default: () => <div /> }));

const testPorts: GraphPorts = {
  now: () => 0,
  schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
  cancel: () => {},
  searchVenues: vi.fn(),
  fetchRoute: vi.fn(),
  writePresence: vi.fn().mockResolvedValue(ok(undefined)),
  placesEnabled: false,
};

const testServices = {
  config: {} as Services["config"],
  firebase: {} as Services["firebase"],
  graphPorts: testPorts,
  presence: { write: vi.fn(), remove: vi.fn() },
  requestSemaphore: {} as Services["requestSemaphore"],
} satisfies Services;

const liveWatches = new Set<number>();

beforeEach(() => {
  vi.clearAllMocks();
  liveWatches.clear();
  let nextId = 0;
  vi.stubGlobal("navigator", {
    geolocation: {
      watchPosition: vi.fn(() => {
        liveWatches.add(++nextId);
        return nextId;
      }),
      clearWatch: vi.fn((id: number) => liveWatches.delete(id)),
      getCurrentPosition: vi.fn(),
    },
  });
  // Like the real one: the code is generated and written to the URL before
  // the first await, so a re-run that re-read the URL would try to join it.
  mockCreateSession.mockImplementation(async (signal: AbortSignal) => {
    history.replaceState(null, "", "/?code=NEW234");
    await Promise.resolve();
    return signal.aborted
      ? { ok: false, error: { code: "CREATE_FAILED", details: "aborted" } }
      : ok("NEW234");
  });
  mockJoinSession.mockResolvedValue(ok("ABC234"));
});

afterEach(() => {
  history.replaceState(null, "", "/");
});

function renderStrict() {
  return render(
    <StrictMode>
      <ServicesProvider services={testServices}>
        <LiveMidpointPage />
      </ServicesProvider>
    </StrictMode>,
  );
}

describe("LiveMidpointPage under StrictMode", () => {
  it("leaves exactly one live GPS watch after mount", async () => {
    renderStrict();
    await act(async () => {});

    expect(liveWatches.size).toBe(1);
  });

  it("finishes one un-aborted create handshake, never a join", async () => {
    renderStrict();
    await act(async () => {});

    const signals = mockCreateSession.mock.calls.map(
      ([signal]) => signal as AbortSignal,
    );
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[signals.length - 1].aborted).toBe(false);
    expect(mockJoinSession).not.toHaveBeenCalled();
  });

  it("joins the code from the URL it was opened with", async () => {
    history.replaceState(null, "", "/?code=ABC234");

    renderStrict();
    await act(async () => {});

    const calls = mockJoinSession.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [code, signal] = calls[calls.length - 1] as [string, AbortSignal];
    expect(code).toBe("ABC234");
    expect(signal.aborted).toBe(false);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("stops the GPS watch on unmount", async () => {
    const { unmount } = renderStrict();
    await act(async () => {});

    unmount();

    expect(liveWatches.size).toBe(0);
  });
});
