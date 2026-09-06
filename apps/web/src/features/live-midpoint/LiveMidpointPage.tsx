import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/useAuth";
import { useServices } from "../../components/ServicesProvider";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useLiveGeolocation } from "./hooks/useLiveGeolocation";
import { useLiveSession } from "./hooks/useLiveSession";
import { useGraph, useGraphRuntime } from "./graph/useGraph";
import type { OtherParticipantView, TravelProfile } from "./graph/types";
import type { RankedVenue } from "./lib/venue-ranking";
import { normalizeCode, isValidCode } from "./lib/session-code";
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

/** Read ?code= from URL query string. */
function getCodeFromURL(): string | null {
  const raw = new URLSearchParams(window.location.search).get("code");
  if (!raw) return null;
  const code = normalizeCode(raw);
  return isValidCode(code) ? code : null;
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
  ]);

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

  // ── Initialize: start geolocation, then create or join session ──
  // The handshake returns a Result rather than throwing. It used to throw into
  // this effect with no `.catch()`, so every failed join raised an unhandled
  // rejection on top of the Sentry event the hook already recorded. The
  // controller cancels the retry loop if we unmount mid-handshake.
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const controller = new AbortController();
    geo.start();

    const urlCode = getCodeFromURL();
    void (async () => {
      const result =
        urlCode !== null
          ? await session.joinSession(urlCode, controller.signal)
          : await session.createSession(controller.signal);
      // The failure is already reflected in session state, which drives the
      // error panel below; nothing further to do but leave a breadcrumb.
      if (!result.ok) {
        console.warn("[live] session handshake failed:", result.error.code);
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally run once on mount
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
    // pagehide also fires on iOS Safari, where beforeunload is unreliable.
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
      // Intentionally do NOT call handleUnload() here. The session and
      // geolocation hooks already tear themselves down on unmount via their
      // own cleanup effects. Running the full teardown on every React unmount
      // breaks StrictMode's dev remount cycle (mount→unmount→mount), where the
      // init effect is guarded by initRef and never restarts GPS/the listener.
    };
  }, []);

  // ── Error states ──
  if (geo.status === "denied") {
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#128205;</div>
          <div className="live-error-title">{t("live.geoDenied")}</div>
          <div className="live-error-message">
            {t("live.geoDeniedInstructions")}
          </div>
        </div>
      </div>
    );
  }

  if (geo.status === "unavailable") {
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#128205;</div>
          <div className="live-error-title">{t("live.geoUnavailable")}</div>
          <div className="live-error-message">
            {t("live.geoUnavailableInstructions")}
          </div>
        </div>
      </div>
    );
  }

  if (geo.status === "error") {
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#9202;</div>
          <div className="live-error-title">{t("live.geoTimeout")}</div>
          <div className="live-error-message">
            {t("live.geoTimeoutInstructions")}
          </div>
          <button
            type="button"
            className="live-btn live-retry-btn"
            onClick={() => geo.start()}
          >
            {t("common.retry")}
          </button>
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
              midpoint={graph.midpoint}
              ownIndex={ownIndex}
              ownPosition={ownPosition}
              ownRoute={routes[ownIndex] ?? null}
              otherParticipants={otherParticipants}
              destination={graph.destination ?? graph.midpoint}
              travelProfile={graph.travelProfile}
              onProfileChange={handleProfileChange}
              selectedVenueName={graph.selectedVenue?.displayName ?? null}
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
