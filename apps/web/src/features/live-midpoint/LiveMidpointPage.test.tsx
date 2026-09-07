import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ParticipantIndex } from "./lib/participant-config";
import { ServicesProvider } from "../../components/ServicesProvider";
import type { Services } from "../../lib/services";
import type { GraphPorts } from "./graph/ports";
import LiveMidpointPage from "./LiveMidpointPage";

// ── Mock i18next ──
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

// ── Mock useAuth ──
const mockAuth = vi.fn();
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => mockAuth(),
}));

// ── Mock useNetworkStatus ──
const mockNetworkStatus = vi.fn();
vi.mock("../../hooks/useNetworkStatus", () => ({
  useNetworkStatus: () => mockNetworkStatus(),
}));

// ── Mock useLiveGeolocation ──
const mockGeo = vi.fn();
vi.mock("./hooks/useLiveGeolocation", () => ({
  useLiveGeolocation: () => mockGeo(),
}));

// ── Mock useLiveSession ──
const mockSession = vi.fn();
vi.mock("./hooks/useLiveSession", () => ({
  useLiveSession: (_uid: string) => mockSession(),
}));

// ── Fake graph ports ──
// The page drives the real graph runtime; only its I/O seam is replaced, so
// these tests exercise the actual slots → midpoint → destination → routes
// derivation rather than a stubbed-out pipeline. Nothing is scheduled, so no
// timers leak between tests.
//
// These are *passed in* through ServicesProvider rather than installed with
// vi.mock, which is the point of the composition root: the page under test is
// the real one, wired to fakes, not a module graph rewritten underneath it.
const mockSearchVenues = vi.fn();
const mockFetchRoute = vi.fn();

const testPorts: GraphPorts = {
  now: () => 0,
  schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
  cancel: () => {},
  searchVenues: mockSearchVenues,
  fetchRoute: mockFetchRoute,
  placesEnabled: false,
};

const testServices = {
  config: {} as Services["config"],
  firebase: {} as Services["firebase"],
  graphPorts: testPorts,
  requestSemaphore: {} as Services["requestSemaphore"],
} satisfies Services;

/** Render the page inside the injection boundary it now expects. */
function renderPage() {
  return render(
    <ServicesProvider services={testServices}>
      <LiveMidpointPage />
    </ServicesProvider>,
  );
}

// ── Mock LiveMap (avoid mapbox-gl in jsdom) ──
// Props are recorded so the referential-stability regression below can assert
// on exactly what the real LiveMap's effects key off.
interface RecordedMapProps {
  participants: unknown;
  routes: unknown;
  midpoint: unknown;
  venues: unknown;
  selectedVenue: unknown;
}
const liveMapProps: RecordedMapProps[] = [];
vi.mock("./components/LiveMap", () => ({
  default: (props: RecordedMapProps) => {
    liveMapProps.push(props);
    return <div data-testid="live-map">Map</div>;
  },
}));

// ── Mock LanguageSwitcher ──
vi.mock("../../components/LanguageSwitcher", () => ({
  default: () => <div data-testid="lang-switcher">Lang</div>,
}));

// ── Mock SessionBadge ──
vi.mock("./components/SessionBadge", () => ({
  default: () => <div data-testid="session-badge">Badge</div>,
}));

// ── Mock WaitingCard ──
vi.mock("./components/WaitingCard", () => ({
  default: ({ code }: { code: string }) => (
    <div data-testid="waiting-card">{code}</div>
  ),
}));

// ── Mock MidpointCard ──
vi.mock("./components/MidpointCard", () => ({
  default: () => <div data-testid="midpoint-card">MidpointCard</div>,
}));

// ── Mock VenueListCard ──
vi.mock("./components/VenueListCard", () => ({
  default: () => <div data-testid="venue-list-card">VenueList</div>,
}));

// ── Mock session-code ──
vi.mock("./lib/session-code", () => ({
  normalizeCode: (c: string) => c.toUpperCase(),
  isValidCode: (c: string) => c.length === 6,
}));

// ── Default mock values ──
function defaultGeo() {
  return {
    status: "watching",
    position: { lat: 32.08, lng: 34.78 },
    accuracy: 10,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function defaultSession() {
  return {
    // Lifecycle only — waiting/connected/some_stale is the graph's to derive.
    status: "ready",
    code: "ABC123",
    ownIndex: 0,
    ownName: "Me",
    participants: [],
    error: null,
    errorDetails: null,
    creatorUid: "test-uid",
    createSession: vi.fn().mockResolvedValue({ ok: true, value: "ABC123" }),
    joinSession: vi.fn().mockResolvedValue({ ok: true, value: "ABC123" }),
    setOwnName: vi.fn(),
    cleanup: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  liveMapProps.length = 0;
  mockSearchVenues.mockResolvedValue({ ok: true, value: [] });
  mockFetchRoute.mockResolvedValue({ ok: true, value: null });
  mockAuth.mockReturnValue({ status: "authenticated", uid: "test-uid" });
  mockNetworkStatus.mockReturnValue({
    browserOnline: true,
    firebaseConnected: true,
    isOnline: true,
  });
  mockGeo.mockReturnValue(defaultGeo());
  mockSession.mockReturnValue(defaultSession());
  // Reset URL to no code
  vi.stubGlobal("location", { ...window.location, search: "" });
});

describe("LiveMidpointPage", () => {
  it("shows loading state when auth is loading", () => {
    mockAuth.mockReturnValue({ status: "loading" });

    renderPage();

    expect(screen.getByText("live.connecting")).toBeTruthy();
  });

  it("renders the session error panel when auth fails", () => {
    mockAuth.mockReturnValue({
      status: "error",
      code: "AUTH_STORAGE_BLOCKED",
      message: "auth/web-storage-unsupported: storage blocked",
    });

    renderPage();

    expect(screen.getByText("live.authStorageBlocked")).toBeTruthy();
    expect(screen.getByText("common.retry")).toBeTruthy();
    expect(
      screen.getByText("auth/web-storage-unsupported: storage blocked"),
    ).toBeTruthy();
  });

  it("shows geo denied error screen", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
    });

    renderPage();

    expect(screen.getByText("live.geoDenied")).toBeTruthy();
    expect(screen.getByText("live.geoDeniedInstructions")).toBeTruthy();
  });

  it("shows geo unavailable error screen", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "unavailable",
      position: null,
    });

    renderPage();

    expect(screen.getByText("live.geoUnavailable")).toBeTruthy();
    expect(screen.getByText("live.geoUnavailableInstructions")).toBeTruthy();
  });

  it("shows geo timeout error with retry button", () => {
    const startFn = vi.fn();
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "error",
      position: null,
      start: startFn,
    });

    renderPage();

    expect(screen.getByText("live.geoTimeout")).toBeTruthy();
    expect(screen.getByText("live.geoTimeoutInstructions")).toBeTruthy();

    const retryBtn = screen.getByText("common.retry");
    expect(retryBtn).toBeTruthy();

    fireEvent.click(retryBtn);
    expect(startFn).toHaveBeenCalled();
  });

  it("shows session not found error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "error",
      error: "SESSION_NOT_FOUND",
    });

    renderPage();

    expect(screen.getByText("live.sessionNotFound")).toBeTruthy();
  });

  it("shows session full error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "error",
      error: "SESSION_FULL",
    });

    renderPage();

    expect(screen.getByText("live.sessionFull")).toBeTruthy();
  });

  it("shows session expired error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "error",
      error: "SESSION_EXPIRED",
    });

    renderPage();

    expect(screen.getByText("live.sessionExpired")).toBeTruthy();
  });

  it("shows waiting card when session is waiting", () => {
    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.getByTestId("session-badge")).toBeTruthy();
  });

  it("shows offline banner when network is offline", () => {
    mockNetworkStatus.mockReturnValue({
      browserOnline: false,
      firebaseConnected: false,
      isOnline: false,
    });

    renderPage();

    expect(screen.getByText("app.offline")).toBeTruthy();
  });

  it("renders waiting card (with share UI) whenever a code exists, even mid-creation", () => {
    // Regression: previously, phase === "creating" with a code rendered no card
    // at all, so the share button silently disappeared. The fix makes WaitingCard
    // the fallback whenever code is set and the connected MidpointCard can't render.
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "connecting",
      code: "ABC123",
    });

    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
  });

  it("falls back to waiting card when connected but no peer positions yet", () => {
    // phase === "connected" can briefly coexist with empty participants during
    // reconnect or a peer leaving, leaving midpoint null. WaitingCard should
    // still render so the share button is reachable.
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: [],
    });

    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.queryByTestId("midpoint-card")).toBeNull();
  });

  it("shows connected state with multiple participants", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: Date.now(),
          index: 1,
          name: null,
        },
        {
          uid: "p2",
          position: { lat: 32.79, lng: 34.99 },
          accuracy: 20,
          lastSeen: Date.now(),
          index: 2,
          name: null,
        },
      ],
    });

    renderPage();

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
  });
});

describe("LiveMidpointPage — render-path stability", () => {
  /** One RTDB heartbeat: same roster, brand-new array and objects. */
  function roster(): ReturnType<typeof defaultSession>["participants"] {
    return [
      {
        uid: "peer-1",
        index: 1 as ParticipantIndex,
        position: { lat: 32.09, lng: 34.79 },
        accuracy: 12,
        lastSeen: Date.now(),
        name: "Peer",
      },
    ];
  }

  it("keeps LiveMap's props referentially stable across an unchanged heartbeat", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: roster(),
    });

    const { rerender } = renderPage();
    const before = liveMapProps.length;
    expect(before).toBeGreaterThan(0);
    const first = liveMapProps[before - 1];

    // RTDB hands over a fresh array on every heartbeat. The slot vector is
    // compared element-wise, so the graph's snapshot does not change — and the
    // page's projections must not either. Rebuilding them in the render body
    // handed LiveMap new arrays every second, re-running setData on five route
    // sources for geometry that had not moved.
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: roster(),
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage />
      </ServicesProvider>,
    );

    expect(liveMapProps.length).toBeGreaterThan(before);
    const second = liveMapProps[liveMapProps.length - 1];

    expect(second.participants).toBe(first.participants);
    expect(second.routes).toBe(first.routes);
    expect(second.midpoint).toBe(first.midpoint);
    expect(second.venues).toBe(first.venues);
  });

  it("hands LiveMap new projections when the roster actually changes", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: roster(),
    });

    const { rerender } = renderPage();
    const first = liveMapProps[liveMapProps.length - 1];

    const moved = roster();
    moved[0] = { ...moved[0], position: { lat: 32.2, lng: 34.9 } };
    mockSession.mockReturnValue({
      ...defaultSession(),
      status: "ready",
      participants: moved,
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage />
      </ServicesProvider>,
    );

    const second = liveMapProps[liveMapProps.length - 1];
    expect(second.participants).not.toBe(first.participants);
  });
});
