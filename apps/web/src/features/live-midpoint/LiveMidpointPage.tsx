import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/useAuth";
import { useServices } from "../../components/ServicesProvider";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useServerTimeOffset } from "../../hooks/useServerTimeOffset";
import { useLiveGeolocation } from "./hooks/useLiveGeolocation";
import type { GeoStatus } from "./hooks/useLiveGeolocation";
import { useLiveSession } from "./hooks/useLiveSession";
import { useGraph, useGraphRuntime } from "./graph/useGraph";
import type { OtherParticipantView, TravelProfile } from "./graph/types";
import type { RankedVenue } from "./lib/venue-ranking";
import { normalizeCode } from "./lib/session-code";
import type { ParticipantIndex } from "./lib/participant-config";
import LiveMap from "./components/LiveMap";
import type { MapParticipant } from "./components/LiveMap";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import SessionErrorPanel from "./components/SessionErrorPanel";
import "./styles/live-midpoint.css";

// Lazy-load VenueListCard — only needed when Places API key is configured
const VenueListCard = lazy(() => import("./components/VenueListCard"));

type GeoErrorStatus = Extract<GeoStatus, "denied" | "unavailable" | "error">;

/** The location failures that replace the page, and what each one says. */
const GEO_ERROR_SCREENS: Record<
  GeoErrorStatus,
  { icon: string; title: string; instructions: string; offerReload: boolean }
> = {
  // Reload as well as Try again: WebKit (every iOS browser) fixes a page's
  // denial for the page's lifetime, so there only a reload asks again — and an
  // installed PWA has no reload control of its own.
  denied: {
    icon: "\u{1F4CD}",
    title: "live.geoDenied",
    instructions: "live.geoDeniedInstructions",
    offerReload: true,
  },
  unavailable: {
    icon: "\u{1F4CD}",
    title: "live.geoUnavailable",
    instructions: "live.geoUnavailableInstructions",
    offerReload: false,
  },
  error: {
    icon: "\u23F2",
    title: "live.geoTimeout",
    instructions: "live.geoTimeoutInstructions",
    offerReload: false,
  },
};

/**
 * Read ?code= from the URL, normalised but not validated: `joinSession`
 * validates, so a mangled code fails as INVALID_CODE. Filtered out here, it
 * read as no code at all, and the page created a new session in place of the
 * one the link named — the joiner sat alone, believing they had joined.
 */
function getCodeFromURL(): string | null {
  const raw = new URLSearchParams(window.location.search).get("code");
  if (!raw) return null;
  return normalizeCode(raw);
}

/** Auth gate — waits for Firebase Anonymous Auth before rendering inner page. */
export default function LiveMidpointPage() {
  const { t } = useTranslation();
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <div className="live-page">
        <div className="live-status">{t("live.connecting")}</div>
      </div>
    );
  }

  if (auth.status === "error") {
    return (
      <SessionErrorPanel errorCode={auth.code} errorDetails={auth.message} />
    );
  }

  return <LiveMidpointInner uid={auth.uid} />;
}

/** Inner page — only renders after auth is resolved. */
function LiveMidpointInner({ uid }: { uid: string }) {
  const { t } = useTranslation();
  const geo = useLiveGeolocation();
  const session = useLiveSession(uid);
  const networkStatus = useNetworkStatus();
  const serverTimeOffsetMs = useServerTimeOffset();

  // ── The derived pipeline ──
  // slots → midpoint → venues → destination → routes, declared in
  // graph/edges.ts and executed in topological order. One subscription
  // replaces the four-hook render cascade, and the snapshot only changes when
  // a value actually changed, so the memo() on the cards below holds.
  const { graphPorts } = useServices();
  const runtime = useGraphRuntime(graphPorts);
  const placesEnabled = graphPorts.placesEnabled;
  const graph = useGraph(runtime);

  // Feed session and GPS state in. These are event streams, not graph nodes:
  // the graph derives from them, never the other way round.
  //
  // `ownPosition` comes straight from geolocation. It used to be mirrored
  // through `useLiveSession` — geo → updateOwnLocation → setOwnPosition →
  // render → setSources — which cost two commits per fix and let position and
  // accuracy in the same slot vector come from two different fixes, because
  // accuracy was already read directly from `geo`.
  useEffect(() => {
    runtime.setSources({
      ownSlot: session.ownIndex,
      ownPosition: geo.position,
      ownAccuracy: geo.accuracy,
      participants: session.participants,
      sessionCode: session.code,
      ownUid: uid,
      ownName: session.ownName,
      sessionStatus: session.status,
      serverTimeOffsetMs,
    });
  }, [
    runtime,
    uid,
    session.ownIndex,
    session.participants,
    session.code,
    session.ownName,
    session.status,
    geo.position,
    geo.accuracy,
    serverTimeOffsetMs,
  ]);

  // Turning location off is turning sharing off. The denial clears the
  // position, so nothing new is published; this takes down what already was,
  // which would otherwise stay on everyone's map — and in the database — until
  // the page closed. Transient GPS failures keep the last fix on purpose.
  const { withdraw } = session;
  useEffect(() => {
    if (geo.status === "denied") withdraw();
  }, [geo.status, withdraw]);

  // Selection and travel mode live in the graph rather than in React state.
  // Mirroring them would give two sources of truth: the list would highlight
  // a venue the graph had already stopped routing to.
  const handleSelectVenue = useCallback(
    (venue: RankedVenue | null) => {
      runtime.setSources({ selectedVenueId: venue?.id ?? null });
    },
    [runtime],
  );

  const handleProfileChange = useCallback(
    (profile: TravelProfile) => {
      runtime.setSources({ travelProfile: profile });
    },
    [runtime],
  );

  // ── View projections ──
  // The graph already hands back referentially stable `slots` and `routes`
  // (SlotVector is compared element-wise, so an unchanged roster reuses the
  // previous object). Projecting them with a bare `.map()` in the render body
  // threw that stability away: this component re-renders on every GPS fix and
  // every RTDB heartbeat, and each fresh array re-ran LiveMap's effects —
  // `setData` on five route sources, re-serialising thousands of coordinate
  // pairs per second for geometry that had not changed. Memoising on the
  // stable inputs is what makes the graph's work actually pay.
  const { slots, routes } = graph;

  const mapParticipants = useMemo<MapParticipant[]>(() => {
    const out: MapParticipant[] = [];
    for (const slot of slots.occupied) {
      const position = slots.positions[slot];
      if (!position) continue;
      out.push({
        position,
        accuracy: slots.accuracy[slot] ?? 0,
        index: slot,
        isOwn: slot === slots.ownSlot,
        stale: slots.stale[slot] ?? false,
      });
    }
    return out;
  }, [slots]);

  // Slot-keyed route geometries — LiveMap paints routes[i] on the `route-{i}`
  // layer in PARTICIPANT_COLORS[i], so this must be indexed by slot.
  const routeGeometries = useMemo(
    () => routes.map((r) => r?.geometry ?? null),
    [routes],
  );

  const badgeParticipants = useMemo(
    () =>
      slots.occupied
        .filter((slot) => slot !== slots.ownSlot)
        .map((slot) => ({
          index: slot,
          connected: true,
          name: slots.names[slot] ?? null,
        })),
    [slots],
  );

  const otherParticipants = useMemo<OtherParticipantView[]>(() => {
    const out: OtherParticipantView[] = [];
    for (const slot of slots.occupied) {
      if (slot === slots.ownSlot) continue;
      const position = slots.positions[slot];
      if (!position) continue;
      out.push({
        index: slot,
        route: routes[slot] ?? null,
        position,
        stale: slots.stale[slot] ?? false,
        name: slots.names[slot] ?? null,
      });
    }
    return out;
  }, [slots, routes]);

  // ── Initialize: stream GPS, and create or join the session ──
  // Both effects are plain start/stop pairs with no run-once guard. They used
  // to share one effect behind an `initRef` guard, which StrictMode — on in
  // every `npm run dev` — defeats: its mount → unmount → mount cycle ran the
  // geolocation hook's cleanup (clearWatch) and aborted the handshake, and the
  // guard then stopped the second mount restarting either. Local dev has
  // never streamed a position since 05365d9 for exactly that reason.
  const { start: startGeo, stop: stopGeo } = geo;
  useEffect(() => {
    startGeo();
    return stopGeo;
  }, [startGeo, stopGeo]);

  // Read once per mount, not inside the effect: createSession rewrites the URL
  // to ?code=<new code>, so a re-run that read it again would try to *join*
  // the session its aborted predecessor never wrote.
  const [urlCode] = useState(getCodeFromURL);

  // The handshake returns a Result rather than throwing. It used to throw into
  // this effect with no `.catch()`, so every failed join raised an unhandled
  // rejection on top of the Sentry event the hook already recorded. The
  // controller cancels the retry loop if we unmount mid-handshake; both
  // handshakes check it before their first write, so an aborted run leaves
  // nothing behind for the next one to trip over.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const result =
        urlCode !== null
          ? await session.joinSession(urlCode, controller.signal)
          : await session.createSession(controller.signal);
      // The failure is already reflected in session state, which drives the
      // error panel below; nothing further to do but leave a breadcrumb.
      if (!result.ok && !controller.signal.aborted) {
        console.warn("[live] session handshake failed:", result.error.code);
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one handshake per mount
  }, []);

  // Own location no longer needs piping to Firebase from here: the graph's
  // `presence` node owns that write, with the debounce, admission control,
  // retry, timeout and breaker every other effectful node gets.

  // ── beforeunload cleanup ──
  const cleanupRef = useRef(session.cleanup);
  cleanupRef.current = session.cleanup;
  const geoStopRef = useRef(geo.stop);
  geoStopRef.current = geo.stop;

  useEffect(() => {
    const handleUnload = () => {
      geoStopRef.current();
      cleanupRef.current();
    };
    // Restored from the back/forward cache, the page comes back without the
    // listener and GPS that pagehide tore down, and nothing restarts them:
    // the map froze on its last frame. A reload rebuilds both.
    const handleShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    // pagehide also fires on iOS Safari, where beforeunload is unreliable.
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("pageshow", handleShow);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("pageshow", handleShow);
      // Intentionally do NOT call handleUnload() here. The session and
      // geolocation hooks already tear themselves down on unmount via their
      // own cleanup effects. Running the full teardown on every React unmount
      // breaks StrictMode's dev remount cycle (mount→unmount→mount), where the
      // init effect is guarded by initRef and never restarts GPS/the listener.
    };
  }, []);

  // ── Error states ──
  // Every location failure gets the same way out. The denied screen used to
  // have none, and it is where a phone with its Location toggle off lands:
  // Chrome reports that as PERMISSION_DENIED and offers its "turn on location"
  // dialog only for a request made inside a tap, so a reload never recovers.
  if (
    geo.status === "denied" ||
    geo.status === "unavailable" ||
    geo.status === "error"
  ) {
    const screen = GEO_ERROR_SCREENS[geo.status];
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">{screen.icon}</div>
          <div className="live-error-title">{t(screen.title)}</div>
          <div className="live-error-message">{t(screen.instructions)}</div>
          <div className="live-error-actions">
            <button
              type="button"
              className="live-btn live-btn-primary"
              onClick={() => geo.start()}
            >
              {t("common.retry")}
            </button>
            {screen.offerReload && (
              <button
                type="button"
                className="live-btn live-btn-secondary"
                onClick={() => window.location.reload()}
              >
                {t("app.reload")}
              </button>
            )}
          </div>
          {/* Open, so a screenshot of this screen carries the reason. */}
          {geo.error && (
            <details className="live-error-details" open>
              <summary>{t("live.errorDetails")}</summary>
              <code>{geo.error}</code>
            </details>
          )}
        </div>
      </div>
    );
  }

  if (graph.phase === "error") {
    return (
      <SessionErrorPanel
        errorCode={session.error ?? "CONNECTION_ERROR"}
        errorDetails={session.errorDetails}
      />
    );
  }

  const ownIndex = session.ownIndex ?? (0 as ParticipantIndex);

  const isConnected =
    graph.phase === "connected" || graph.phase === "some_stale";

  // Read own position back out of the slot vector rather than from a second
  // source: everything on screen is keyed by slot, and this is that index.
  const ownPosition =
    slots.ownSlot === null ? null : (slots.positions[slots.ownSlot] ?? null);

  return (
    <main className="live-page">
      <LiveMap
        participants={mapParticipants}
        midpoint={graph.midpoint}
        routes={routeGeometries}
        venues={graph.venues}
        selectedVenue={graph.selectedVenue}
      />

      {session.code && (
        <SessionBadge
          code={session.code}
          phase={graph.phase}
          ownConnected={geo.status === "watching"}
          ownIndex={ownIndex}
          ownName={session.ownName}
          onNameChange={session.setOwnName}
          participants={badgeParticipants}
        />
      )}

      {!networkStatus.isOnline && (
        <div className="live-offline-banner">
          <span>&#9888;</span>
          {t("app.offline")}
        </div>
      )}

      {/* The graph knew, and nothing said so: the others saw this
          participant go stale while their own screen looked fine. Offline
          already has its banner. */}
      {networkStatus.isOnline && graph.presenceFailed && (
        <div className="live-offline-banner" role="status">
          <span>&#9888;</span>
          {t("live.presenceFailed")}
        </div>
      )}

      {session.code &&
        (isConnected && graph.midpoint && ownPosition ? (
          <div className="live-bottom-panel">
            {placesEnabled && (
              <Suspense fallback={null}>
                <VenueListCard
                  venues={graph.venues}
                  loading={graph.venuesLoading}
                  selectedVenue={graph.selectedVenue}
                  onSelectVenue={handleSelectVenue}
                />
              </Suspense>
            )}
            <MidpointCard
              ownIndex={ownIndex}
              ownPosition={ownPosition}
              ownRoute={routes[ownIndex] ?? null}
              otherParticipants={otherParticipants}
              destination={graph.destination ?? graph.midpoint}
              travelProfile={graph.travelProfile}
              onProfileChange={handleProfileChange}
              selectedVenueName={graph.selectedVenue?.displayName ?? null}
              routesStale={graph.routesDegraded}
              code={session.code}
              participantCount={session.participants.length + 1}
            />
          </div>
        ) : (
          <WaitingCard code={session.code} />
        ))}
    </main>
  );
}
