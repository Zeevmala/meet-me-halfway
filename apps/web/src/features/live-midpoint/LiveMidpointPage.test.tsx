import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ParticipantIndex } from "./lib/participant-config";
import { ServicesProvider } from "../../components/ServicesProvider";
import type { Services } from "../../lib/services";
import type { GraphPorts } from "./graph/ports";
import LiveMidpointPage from "./LiveMidpointPage";
import type { ParticipantInfo, SessionState } from "./hooks/useLiveSession";
import type { PinEvent } from "./graph/types";
import { ok, err } from "../../core/dag/result";
import { DEPARTED_THRESHOLD_MS, SESSION_TTL_MS } from "./graph/nodes";

// ── Mock the string table ──
vi.mock("../../strings", () => ({
  t: (key: string, opts?: Record<string, unknown>) => {
    if (opts) return `${key}:${JSON.stringify(opts)}`;
    return key;
  },
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

// ── Mock useServerTimeOffset (an RTDB `.info` listener, like the above) ──
const mockServerTimeOffset = vi.fn();
vi.mock("../../hooks/useServerTimeOffset", () => ({
  useServerTimeOffset: () => mockServerTimeOffset(),
}));

// ── Mock useLiveGeolocation ──
const mockGeo = vi.fn();
vi.mock("./hooks/useLiveGeolocation", () => ({
  useLiveGeolocation: () => mockGeo(),
}));

// ── Mock useLiveSession ──
// Only the hook is replaced: the page also takes the module's constants.
const mockSession = vi.fn();
vi.mock("./hooks/useLiveSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hooks/useLiveSession")>()),
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
const mockWritePresence = vi.fn().mockResolvedValue(ok(undefined));
const mockPresenceRemove = vi.fn();

const testPorts: GraphPorts = {
  now: () => 0,
  schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
  cancel: () => {},
  searchVenues: mockSearchVenues,
  fetchRoute: mockFetchRoute,
  // The presence node publishes own location through this seam. Nothing here
  // schedules, so it is never actually driven — it exists so the fake satisfies
  // the same contract production does.
  writePresence: mockWritePresence,
  removePresence: mockPresenceRemove,
  writeMeet: vi.fn().mockResolvedValue(ok(undefined)),
  removeMeet: vi.fn(),
  placesEnabled: false,
};

const testServices = {
  config: {} as Services["config"],
  firebase: {} as Services["firebase"],
  graphPorts: testPorts,
  requestSemaphore: {} as Services["requestSemaphore"],
} satisfies Services;

/**
 * Render the page inside the injection boundary it now expects.
 *
 * `urlCode` is the session the link named: `App` reads it from the URL and
 * mounts the page only once the person has agreed to start or join.
 */
function renderPage(urlCode: string | null = null) {
  return render(
    <ServicesProvider services={testServices}>
      <LiveMidpointPage urlCode={urlCode} />
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
  pinned: unknown;
  insets: unknown;
}
const liveMapProps: RecordedMapProps[] = [];
vi.mock("./components/LiveMap", () => ({
  default: (props: RecordedMapProps) => {
    liveMapProps.push(props);
    return <div data-testid="live-map">Map</div>;
  },
}));

// ── Mock SessionBadge ──
vi.mock("./components/SessionBadge", () => ({
  default: ({ canInvite }: { canInvite: boolean }) => (
    <div data-testid="session-badge" data-can-invite={String(canInvite)}>
      Badge
    </div>
  ),
}));

// ── Mock WaitingCard ──
vi.mock("./components/WaitingCard", () => ({
  default: ({ code, full }: { code: string; full?: boolean }) => (
    <div data-testid="waiting-card" data-full={String(full ?? false)}>
      {code}
    </div>
  ),
}));

// ── Mock MidpointCard ──
// Props recorded, so the meeting-point cases can see what the card is told
// and press what it is given.
interface RecordedCardProps {
  destination: { lat: number; lng: number };
  pin: { setBy: string | null; name: string | null } | null;
  onMovePin: (() => void) | null;
  onNavigate: () => void;
}
const cardProps: RecordedCardProps[] = [];
vi.mock("./components/MidpointCard", () => ({
  default: (props: RecordedCardProps) => {
    cardProps.push(props);
    return <div data-testid="midpoint-card">MidpointCard</div>;
  },
}));
const lastCard = (): RecordedCardProps => {
  const props = cardProps[cardProps.length - 1];
  if (props === undefined) throw new Error("the meeting card was not shown");
  return props;
};

// ── Mock VenueListCard ──
vi.mock("./components/VenueListCard", () => ({
  default: () => <div data-testid="venue-list-card">VenueList</div>,
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

/** Live in slot 0, created at the test ports' epoch: 24 hours from expiry. */
const LIVE: SessionState = {
  kind: "live",
  code: "ABC123",
  slot: 0,
  createdAtMs: 0,
};

function failed(reason: string, details: string | null = null): SessionState {
  return {
    kind: "failed",
    reason: reason as Extract<SessionState, { kind: "failed" }>["reason"],
    details,
  };
}

function defaultSession() {
  return {
    // The session's whole state; waiting/connected/some_stale is the graph's
    // to derive from it.
    state: LIVE,
    ownName: "Me",
    // Annotated: an untyped [] infers never[], which silently made every
    // roster fixture below unassignable — and the spread in the movement test
    // a spread of `never`.
    participants: [] as ParticipantInfo[],
    // Own claim only. Claims are not the participants: they never shrink.
    claimedSlots: 1,
    // Nobody has set a meeting point.
    peerPins: [] as PinEvent[],
    createSession: vi.fn().mockResolvedValue({ ok: true, value: "ABC123" }),
    joinSession: vi.fn().mockResolvedValue({ ok: true, value: "ABC123" }),
    setOwnName: vi.fn(),
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  liveMapProps.length = 0;
  cardProps.length = 0;
  mockSearchVenues.mockResolvedValue({ ok: true, value: [] });
  mockFetchRoute.mockResolvedValue({ ok: true, value: null });
  mockAuth.mockReturnValue({ status: "authenticated", uid: "test-uid" });
  mockNetworkStatus.mockReturnValue({
    browserOnline: true,
    firebaseConnected: true,
    connectivity: "online",
  });
  mockServerTimeOffset.mockReturnValue(0);
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

  // Turning location off is turning sharing off: the last position must not
  // stay on everyone's map, and in the database, until the page closes. The
  // graph's presence node publishes it and is the one that takes it down.
  it("removes own position when location is denied", () => {
    const { rerender } = renderPage();
    expect(mockPresenceRemove).not.toHaveBeenCalled();

    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    expect(mockPresenceRemove).toHaveBeenCalledWith("ABC123", 0);
  });

  it("keeps own position through a transient location failure", () => {
    const { rerender } = renderPage();

    mockGeo.mockReturnValue({ ...defaultGeo(), status: "unavailable" });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    expect(mockPresenceRemove).not.toHaveBeenCalled();
  });

  // A denial must not be a dead end: a phone with its Location toggle off
  // lands here, and only a request made inside a tap lets Chrome offer to
  // turn Location on.
  it("geo denied screen: Try again restarts GPS, and the reason is visible", () => {
    const error = "PERMISSION_DENIED: User denied Geolocation";
    const startFn = vi.fn();
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
      error,
      start: startFn,
    });

    renderPage();
    // The mount effect starts GPS once; the button must start it again.
    startFn.mockClear();
    fireEvent.click(screen.getByText("common.retry"));

    expect(startFn).toHaveBeenCalledTimes(1);
    // Open by default, so a screenshot says what actually failed.
    const reason = screen.getByText(error);
    expect(reason.closest("details")?.open).toBe(true);
  });

  // It used to share `unavailable` — and its Try again — with a device still
  // retrying, though no request in this browser can succeed.
  it("says so when the browser has no geolocation, with nothing to retry", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "unsupported",
      position: null,
      error: "Geolocation is not supported by this browser.",
    });

    renderPage();

    expect(screen.getByText("live.geoUnsupported")).toBeTruthy();
    expect(screen.getByText("live.geoUnsupportedInstructions")).toBeTruthy();
    expect(screen.queryByText("common.retry")).toBeNull();
    expect(screen.queryByText("app.reload")).toBeNull();
    expect(
      screen.getByText("Geolocation is not supported by this browser."),
    ).toBeTruthy();
  });

  // A slow or failing GPS stops nothing: the watch keeps acquiring after a
  // timeout, and the hook restarts one the device failed. Both used to be
  // full-screen failures, whose Try again tore down the watch at work.
  it.each([
    ["timeout", "live.locationSlow"],
    ["unavailable", "live.locationUnavailable"],
  ] as const)(
    "draws a GPS %s as a banner over the map, with nothing to tap",
    (status, message) => {
      const startFn = vi.fn();
      mockGeo.mockReturnValue({
        ...defaultGeo(),
        status,
        position: null,
        accuracy: null,
        start: startFn,
      });

      renderPage();

      expect(screen.getByTestId("live-map")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain(message);
      expect(screen.getByTestId("waiting-card")).toBeTruthy();
      expect(screen.queryByText("common.retry")).toBeNull();
      expect(screen.queryByText("app.reload")).toBeNull();
      // Started once, by the mount effect, and left to acquire.
      expect(startFn).toHaveBeenCalledTimes(1);
    },
  );

  // Nothing about location can help a session that has ended, so the ended
  // session is what the page says.
  it("says the session has ended rather than that location is denied", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
    });
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: failed("SESSION_FULL"),
    });

    renderPage();

    expect(screen.getByText("live.sessionFull")).toBeTruthy();
    expect(screen.queryByText("live.geoDenied")).toBeNull();
  });

  it("geo denied screen offers Reload, for WebKit's page-lifetime denial", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, search: "", reload });
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
    });

    renderPage();
    fireEvent.click(screen.getByText("app.reload"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows session not found error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: failed("SESSION_NOT_FOUND"),
    });

    renderPage();

    expect(screen.getByText("live.sessionNotFound")).toBeTruthy();
  });

  it("shows session full error", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: failed("SESSION_FULL"),
    });

    renderPage();

    expect(screen.getByText("live.sessionFull")).toBeTruthy();
  });

  // Expiry is the graph's to derive, from `created` and the server clock: a
  // session created a full day before the ports' clock reads has ended.
  it("shows session expired once its 24 hours are up", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: { ...LIVE, createdAtMs: -SESSION_TTL_MS },
    });

    renderPage();

    expect(screen.getByText("live.sessionExpired")).toBeTruthy();
    expect(screen.getByText("live.startNewSession")).toBeTruthy();
  });

  it("says there is a connection problem once the listener is lost", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: {
        kind: "lost",
        code: "ABC123",
        slot: 0,
        createdAtMs: 0,
        details: "permission_denied",
      },
    });

    renderPage();

    expect(screen.getByText("live.connectionError")).toBeTruthy();
    expect(screen.getByText("permission_denied")).toBeTruthy();
  });

  it("shows waiting card when session is waiting", () => {
    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.getByTestId("session-badge")).toBeTruthy();
  });

  // Dropped as "no code", a mangled ?code= started a new session in place of
  // the one the link named. `App` turns one away before the page mounts; a
  // code that reaches the page all the same is joined, never replaced.
  it("hands the code it was given to the join rather than creating a session", () => {
    const session = defaultSession();
    mockSession.mockReturnValue(session);

    renderPage("!!BAD");

    expect(session.joinSession).toHaveBeenCalledWith(
      "!!BAD",
      expect.any(AbortSignal),
    );
    expect(session.createSession).not.toHaveBeenCalled();
  });

  // pagehide tears down the listener and GPS. Restored from the
  // back/forward cache, nothing restarted them and the map froze.
  it("reloads when the page is restored from the back/forward cache", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, search: "", reload });
    renderPage();

    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false }),
    );
    expect(reload).not.toHaveBeenCalled();

    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The graph knew own location was not getting through, and nothing said
  // so: the others watched this participant go stale while this screen
  // looked fine.
  it("says so when own location is not reaching the others", async () => {
    vi.useFakeTimers();
    try {
      // These ports run on the wall clock, so the session has to be created
      // on it too; created at the epoch, it would read as long expired.
      mockSession.mockReturnValue({
        ...defaultSession(),
        state: { ...LIVE, createdAtMs: Date.now() },
      });
      const failing: GraphPorts = {
        ...testPorts,
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (id) => clearTimeout(id),
        writePresence: vi
          .fn()
          .mockResolvedValue(err({ kind: "DENIED", detail: "denied" })),
      };
      render(
        <ServicesProvider services={{ ...testServices, graphPorts: failing }}>
          <LiveMidpointPage urlCode={null} />
        </ServicesProvider>,
      );
      expect(screen.queryByText("live.presenceFailed")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.getByText("live.presenceFailed")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows offline banner when network is offline", () => {
    mockNetworkStatus.mockReturnValue({
      browserOnline: false,
      firebaseConnected: false,
      connectivity: "offline",
    });

    renderPage();

    expect(screen.getByRole("status").textContent).toContain("app.offline");
  });

  // The iPhone in the bug report was told "You are offline" while the map
  // loaded its tiles: the network was fine, the database was not reachable.
  it("says the server cannot be reached, not that the device is offline", () => {
    mockNetworkStatus.mockReturnValue({
      browserOnline: true,
      firebaseConnected: false,
      connectivity: "unreachable",
    });

    renderPage();

    expect(screen.getByRole("status").textContent).toContain(
      "app.serverUnreachable",
    );
    expect(screen.queryByText("app.offline")).toBeNull();
  });

  it("shows no connectivity banner while connected", () => {
    renderPage();

    expect(screen.queryByText("app.offline")).toBeNull();
    expect(screen.queryByText("app.serverUnreachable")).toBeNull();
  });

  it("renders waiting card (with share UI) as soon as the session is live, before any position", () => {
    // Regression: a phase with a code but no card used to render nothing, so
    // the share button silently disappeared. A code now exists exactly when
    // the session is live, and the share UI comes with it — before own GPS
    // has a fix, and before anyone else has a position.
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "requesting",
      position: null,
      accuracy: null,
    });

    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.getByTestId("session-badge")).toBeTruthy();
  });

  // The hook holds the code back until the database has the session, so this
  // is what a creator sees until then — a status, and nothing to share.
  it("says it is setting up, with nothing to share, while a create is pending", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: { kind: "creating", handshake: 1 },
    });

    renderPage();

    expect(screen.getByRole("status").textContent).toBe("live.creating");
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(screen.queryByTestId("session-badge")).toBeNull();
  });

  // A joiner whose handshake had not finished used to look at a bare map — for
  // good, on the devices that could not connect.
  it("says it is connecting while a join is pending", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: { kind: "joining", handshake: 1 },
    });

    renderPage("ABC234");

    expect(screen.getByRole("status").textContent).toBe("live.connecting");
    expect(screen.queryByTestId("waiting-card")).toBeNull();
  });

  // `pagehide` is the page really going. It acts at once — React would
  // render after the page is gone — so own position comes down while the
  // socket is still open.
  it("stops sharing the moment the page is hidden", () => {
    const session = defaultSession();
    const geo = defaultGeo();
    mockSession.mockReturnValue(session);
    mockGeo.mockReturnValue(geo);
    renderPage();
    expect(mockPresenceRemove).not.toHaveBeenCalled();

    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );

    expect(mockPresenceRemove).toHaveBeenCalledWith("ABC123", 0);
    expect(session.close).toHaveBeenCalled();
    expect(geo.stop).toHaveBeenCalled();
  });

  // `beforeunload` exists so a page can cancel a navigation, so it can fire
  // for one that never happens. It used to tear down a page that stayed open.
  it("does not tear anything down on beforeunload", () => {
    const session = defaultSession();
    const geo = defaultGeo();
    mockSession.mockReturnValue(session);
    mockGeo.mockReturnValue(geo);
    renderPage();

    window.dispatchEvent(new Event("beforeunload"));

    expect(mockPresenceRemove).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(geo.stop).not.toHaveBeenCalled();
  });

  it("drops the status once the session is ready", () => {
    renderPage();

    expect(screen.queryByText("live.creating")).toBeNull();
    expect(screen.getByTestId("waiting-card")).toBeTruthy();
  });

  it("falls back to waiting card when connected but no peer positions yet", () => {
    // phase === "connected" can briefly coexist with empty participants during
    // reconnect or a peer leaving, leaving midpoint null. WaitingCard should
    // still render so the share button is reachable.
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [],
    });

    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.queryByTestId("midpoint-card")).toBeNull();
  });

  // The others were on the map, and the sheet said "Waiting for others to
  // join": the one missing was this phone's own fix.
  it("says it is locating, not waiting, while the others are here and own GPS has no fix", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "requesting",
      position: null,
      accuracy: null,
    });
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0,
          index: 1,
          name: null,
        },
      ],
      claimedSlots: 2,
    });

    renderPage();

    expect(screen.getByRole("status").textContent).toBe("live.locating");
    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(screen.queryByTestId("midpoint-card")).toBeNull();
  });

  // A claim is never released. Counting the people present offered invites
  // into a session that had had five, which nobody new could join.
  it("offers no invite once all five slots are claimed, however few are here", () => {
    mockSession.mockReturnValue({ ...defaultSession(), claimedSlots: 5 });

    renderPage();

    expect(screen.getByTestId("waiting-card").dataset.full).toBe("true");
    expect(screen.getByTestId("session-badge").dataset.canInvite).toBe("false");
  });

  it("offers the invite while a slot is free", () => {
    mockSession.mockReturnValue({ ...defaultSession(), claimedSlots: 4 });

    renderPage();

    expect(screen.getByTestId("waiting-card").dataset.full).toBe("false");
    expect(screen.getByTestId("session-badge").dataset.canInvite).toBe("true");
  });

  it("goes by the claims, not the people present, in a meeting too", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0,
          index: 1,
          name: null,
        },
      ],
      claimedSlots: 5,
    });

    renderPage();

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
    expect(screen.getByTestId("session-badge").dataset.canInvite).toBe("false");
  });

  // A slot is what lets a device read every position, and a device that
  // shares none of its own was on nobody's map: the creator's screen said
  // "Waiting for others to join" while someone was already watching.
  it("says so when a device has joined without sharing its location", () => {
    mockSession.mockReturnValue({ ...defaultSession(), claimedSlots: 2 });

    renderPage();

    expect(screen.getByTestId("waiting-card")).toBeTruthy();
    expect(screen.getByText("live.unseenDeviceOne")).toBeTruthy();
  });

  it("counts every such device, in a meeting too", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0,
          index: 1,
          name: null,
        },
      ],
      claimedSlots: 4,
    });

    renderPage();

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
    expect(screen.getByText('live.unseenDeviceMany:{"count":2}')).toBeTruthy();
  });

  it("says nothing of it while everyone who joined is on the map", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0,
          index: 1,
          name: null,
        },
      ],
      claimedSlots: 2,
    });

    renderPage();

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
    expect(screen.queryByText(/live\.unseenDevice/)).toBeNull();
  });

  // A claim is never released. Somebody who shared and then left — gone to
  // navigate, usually — was named as a device watching unseen.
  it("says nothing of a device that shared and then left", () => {
    const here = {
      uid: "p1",
      position: { lat: 31.77, lng: 35.21 },
      accuracy: 15,
      lastSeen: 0,
      index: 1 as ParticipantIndex,
      name: null,
    };
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [here],
      claimedSlots: 2,
    });
    const { rerender } = renderPage();

    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [],
      claimedSlots: 2,
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    expect(screen.queryByText(/live\.unseenDevice/)).toBeNull();
  });

  // The links were part of the waiting card, which a joiner never sees: they
  // go from "Connecting" straight to the meeting.
  it("keeps the privacy policy and terms under the meeting card", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0,
          index: 1,
          name: null,
        },
      ],
      claimedSlots: 2,
    });

    renderPage();

    expect(screen.getByTestId("midpoint-card")).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.privacy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.terms" })).toBeTruthy();
  });

  it("links the privacy policy from the screen that asks for location", () => {
    mockGeo.mockReturnValue({
      ...defaultGeo(),
      status: "denied",
      position: null,
      accuracy: null,
    });

    renderPage();

    expect(screen.getByText("live.geoDenied")).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.privacy" })).toBeTruthy();
  });

  // The start screen's agreement was to "a session of my own", which had no
  // code then. A reload of this tab finds the code in the URL, and has to
  // find the agreement under it, or the creator is asked again.
  it("remembers the agreement under the session's code once it is live", () => {
    window.sessionStorage.clear();

    renderPage();

    expect(window.sessionStorage.getItem("mmh:consent")).toBe("ABC123");
  });

  // With storage blocked the name typed on the start screen reaches the
  // session no other way.
  it("gives the session the name typed on the start screen", () => {
    const session = defaultSession();
    mockSession.mockReturnValue(session);

    render(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} initialName="Dana" />
      </ServicesProvider>,
    );

    expect(session.setOwnName).toHaveBeenCalledWith("Dana");
  });

  it("leaves the session's name alone when none was typed", () => {
    const session = defaultSession();
    mockSession.mockReturnValue(session);

    renderPage();

    expect(session.setOwnName).not.toHaveBeenCalled();
  });

  it("remembers nothing while there is no session to have agreed to", () => {
    window.sessionStorage.clear();
    mockSession.mockReturnValue({
      ...defaultSession(),
      state: { kind: "creating", handshake: 1 },
    });

    renderPage();

    expect(window.sessionStorage.getItem("mmh:consent")).toBeNull();
  });

  it("shows connected state with multiple participants", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
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

  // Peers' `lastSeen` is server-stamped; the graph can only judge it against
  // server time if the page hands it the offset, which RTDB reports after
  // connecting — here, one that puts the server two minutes ahead.
  it("judges peers against the server's clock once its offset is known", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [
        {
          uid: "p1",
          position: { lat: 31.77, lng: 35.21 },
          accuracy: 15,
          lastSeen: 0, // the test ports' clock reads 0 too
          index: 1,
          name: null,
        },
      ],
    });
    const { rerender } = renderPage();
    expect(screen.getByTestId("midpoint-card")).toBeTruthy();

    mockServerTimeOffset.mockReturnValue(DEPARTED_THRESHOLD_MS);
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    expect(screen.queryByTestId("midpoint-card")).toBeNull();
    expect(screen.getByTestId("waiting-card")).toBeTruthy();
  });
});

describe("LiveMidpointPage — the meeting point", () => {
  const PEER = {
    uid: "p1",
    position: { lat: 31.77, lng: 35.21 },
    accuracy: 15,
    lastSeen: 0,
    index: 1 as ParticipantIndex,
    name: "Dana",
  };
  const HAIFA = { lat: 32.794, lng: 34.99 };

  it("goes to the live midpoint, with nobody named, until somebody sets one", () => {
    mockSession.mockReturnValue({ ...defaultSession(), participants: [PEER] });

    renderPage();

    expect(lastCard().pin).toBeNull();
    expect(lastCard().onMovePin).toBeNull();
  });

  // Going is the decision: the destination stops moving with the others.
  it("fixes the destination for everyone as Navigate is followed", () => {
    mockSession.mockReturnValue({ ...defaultSession(), participants: [PEER] });
    renderPage();
    const midpoint = lastCard().destination;

    act(() => lastCard().onNavigate());

    expect(lastCard().pin).toEqual({ setBy: null, name: null });
    expect(lastCard().destination).toEqual(midpoint);
  });

  it("says who set it, by the name they share", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [PEER],
      peerPins: [{ at: 5, by: 1, byName: null, position: HAIFA, name: null }],
    });

    renderPage();

    expect(lastCard().pin).toEqual({ setBy: "Dana", name: null });
    expect(lastCard().destination).toEqual(HAIFA);
  });

  // The regression: whoever tapped Navigate left the page for the navigation
  // app, and the others' Navigate buttons went with them.
  it("keeps the meeting card once everybody else has left", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [],
      peerPins: [{ at: 5, by: 1, byName: null, position: HAIFA, name: null }],
    });

    renderPage();

    expect(screen.queryByTestId("waiting-card")).toBeNull();
    expect(lastCard().destination).toEqual(HAIFA);
    // Unnamed and gone: their slot's label.
    expect(lastCard().pin).toEqual({
      setBy: 'live.participant:{"n":2}',
      name: null,
    });
  });

  // They are usually gone by the time anyone reads it, and their name went
  // with their entry: "Set by P1" said nothing.
  it("names someone who has left by the name they set it under", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [],
      peerPins: [{ at: 5, by: 1, byName: "Dana", position: HAIFA, name: null }],
    });

    renderPage();

    expect(lastCard().pin).toEqual({ setBy: "Dana", name: null });
  });

  it("offers to move it once the live midpoint has wandered, and moves it there", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [PEER],
      peerPins: [{ at: 5, by: 1, byName: null, position: HAIFA, name: null }],
    });
    renderPage();
    const move = lastCard().onMovePin;
    if (move === null) throw new Error("no move offered");

    act(() => move());

    expect(lastCard().pin).toEqual({ setBy: null, name: null });
    expect(lastCard().destination).not.toEqual(HAIFA);
    expect(lastCard().onMovePin).toBeNull();
  });

  it("draws the meeting point on the map", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: [PEER],
      peerPins: [{ at: 5, by: 1, byName: null, position: HAIFA, name: null }],
    });

    renderPage();

    expect(liveMapProps[liveMapProps.length - 1]?.pinned).toEqual(HAIFA);
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
      participants: roster(),
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    expect(liveMapProps.length).toBeGreaterThan(before);
    const second = liveMapProps[liveMapProps.length - 1];

    expect(second.participants).toBe(first.participants);
    expect(second.routes).toBe(first.routes);
    expect(second.midpoint).toBe(first.midpoint);
    expect(second.venues).toBe(first.venues);
    // The overlays' footprint changes only when the layout does; a fresh
    // object per render would refit the map on every heartbeat.
    expect(second.insets).toBe(first.insets);
  });

  it("hands LiveMap new projections when the roster actually changes", () => {
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: roster(),
    });

    const { rerender } = renderPage();
    const first = liveMapProps[liveMapProps.length - 1];

    const moved = roster();
    moved[0] = { ...moved[0], position: { lat: 32.2, lng: 34.9 } };
    mockSession.mockReturnValue({
      ...defaultSession(),
      participants: moved,
    });
    rerender(
      <ServicesProvider services={testServices}>
        <LiveMidpointPage urlCode={null} />
      </ServicesProvider>,
    );

    const second = liveMapProps[liveMapProps.length - 1];
    expect(second.participants).not.toBe(first.participants);
  });
});
