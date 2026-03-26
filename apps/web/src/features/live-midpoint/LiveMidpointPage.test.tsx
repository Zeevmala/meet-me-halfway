import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

// ── Mock useDirections ──
vi.mock("./hooks/useDirections", () => ({
  useDirections: () => ({
    routes: [],
    loading: false,
    error: null,
  }),
}));

// ── Mock useVenueSearch ──
vi.mock("./hooks/useVenueSearch", () => ({
  useVenueSearch: () => ({ venues: [], loading: false, error: null }),
}));

// ── Mock LiveMap (avoid mapbox-gl in jsdom) ──
vi.mock("./components/LiveMap", () => ({
  default: () => <div data-testid="live-map">Map</div>,
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
    phase: "waiting",
    code: "ABC123",
    ownIndex: 0,
    ownPosition: { lat: 32.08, lng: 34.78 },
    participants: [],
    error: null,
    createSession: vi.fn(),
    joinSession: vi.fn(),
    updateOwnLocation: vi.fn(),
    cleanup: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.connecting")).toBeTruthy();
  });

  it("shows auth error when auth fails", () => {
    mockAuth.mockReturnValue({ status: "error", error: "Auth failed" });

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.authError")).toBeTruthy();
    expect(screen.getByText("Auth failed")).toBeTruthy();
  });

  it("shows geo denied error screen", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
    });

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.geoDenied")).toBeTruthy();
    expect(screen.getByText("live.geoDeniedInstructions")).toBeTruthy();
  });

  it("shows geo unavailable error screen", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "unavailable",
      position: null,
    });

    render(<LiveMidpointPage />);

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

    render(<LiveMidpointPage />);

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
      phase: "error",
      error: "SESSION_NOT_FOUND",
    });

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.sessionNotFound")).toBeTruthy();
  });

  it("shows session full error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      phase: "error",
      error: "SESSION_FULL",
    });

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.sessionFull")).toBeTruthy();
  });

  it("shows session expired error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      phase: "error",
      error: "SESSION_EXPIRED",
    });

    render(<LiveMidpointPage />);

    expect(screen.getByText("live.sessionExpired")).toBeTruthy();
  });

  it("shows waiting card when session is waiting", () => {
    render(<LiveMidpointPage />);

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.getByTestId("session-badge")).toBeTruthy();
  });

  it("shows offline banner when network is offline", () => {
    mockNetworkStatus.mockReturnValue({
      browserOnline: false,
      firebaseConnected: false,
      isOnline: false,
    });

    render(<LiveMidpointPage />);

    expect(screen.getByText("app.offline")).toBeTruthy();
  });

  it("shows connected state with multiple participants", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      phase: "connected",
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: Date.now(),
          index: 1,
          stale: false,
        },
        {
          uid: "p2",
          position: { lat: 32.79, lng: 34.99 },
          accuracy: 20,
          lastSeen: Date.now(),
          index: 2,
          stale: false,
        },
      ],
    });

    render(<LiveMidpointPage />);

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
    expect(screen.getByTestId("venue-list-card")).toBeTruthy();
  });
});
