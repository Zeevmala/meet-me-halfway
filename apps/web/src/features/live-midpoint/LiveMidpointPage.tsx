import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { t } from "../../strings";
import type { StringKey } from "../../strings";
import { useAuth } from "../../hooks/useAuth";
import { useServices } from "../../components/ServicesProvider";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import type { Connectivity } from "../../hooks/useNetworkStatus";
import { useServerTimeOffset } from "../../hooks/useServerTimeOffset";
import { useLiveGeolocation } from "./hooks/useLiveGeolocation";
import { CLOSED_SESSION, useLiveSession } from "./hooks/useLiveSession";
import { useOverlayInsets } from "./hooks/useOverlayInsets";
import { useGraph, useGraphRuntime } from "./graph/useGraph";
import { PIN_DRIFT_M, sessionCode, sessionSlot } from "./graph/nodes";
import { haversineDistance } from "./lib/geo-math";
import type { OtherParticipantView, TravelProfile } from "./graph/types";
import { deriveScreen } from "./screen";
import type { LocationTrouble, Screen, Sheet } from "./screen";
import type { RankedVenue } from "./lib/venue-ranking";
import { rememberConsent } from "./lib/consent";
import { participantInitial } from "./lib/display-name";
import type { ParticipantIndex } from "./lib/participant-config";
import type { MapParticipant } from "./graph/types";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import SessionErrorPanel from "./components/SessionErrorPanel";
import LegalLinks from "./components/LegalLinks";
import { pendingWhileReloading } from "../../lib/stale-chunk-reload";
import "./styles/live-midpoint.css";

// Lazy-load VenueListCard — only needed when Places API key is configured
const VenueListCard = lazy(
  pendingWhileReloading(() => import("./components/VenueListCard")),
);

/**
 * The map, loaded on its own. It is most of what this page weighs —
 * mapbox-gl is ~545 KB gzipped — and it was a static import, so nothing on
 * the page could start before it had arrived: not the sign-in, not the
 * location request, not the session handshake. A reload into a remembered
 * session waited on it every time. Now they run while it loads, and the map
 * fills in under the sheet when it comes.
 */
export const loadLiveMap = pendingWhileReloading(
  () => import("./components/LiveMap"),
);
const LiveMap = lazy(loadLiveMap);

/**
 * What the banner says when the page cannot talk to the database. Two
 * messages, because "You are offline" over a map still loading its tiles told
 * the user to fix a network that was working.
 */
const CONNECTIVITY_BANNER: Record<
  Exclude<Connectivity, "online">,
  StringKey
> = {
  offline: "app.offline",
  unreachable: "app.serverUnreachable",
};

/**
 * The two location states that replace the map, and what each says. Both stop
 * sharing until the user acts; a slow or failing GPS does not, and is a
 * banner instead.
 */
const LOCATION_SCREENS: Record<
  Extract<Screen["kind"], "locationDenied" | "locationUnsupported">,
  { title: StringKey; instructions: StringKey; canRetry: boolean }
> = {
  locationDenied: {
    title: "live.geoDenied",
    instructions: "live.geoDeniedInstructions",
    canRetry: true,
  },
  // Nothing to retry: no request in this browser can succeed.
  locationUnsupported: {
    title: "live.geoUnsupported",
    instructions: "live.geoUnsupportedInstructions",
    canRetry: false,
  },
};

/**
 * Location trouble that stops nothing. A timeout leaves the watch acquiring,
 * and the hook restarts one the device failed, so there is nothing to tap:
 * the Try again these had as full screens tore down a watch still at work.
 */
const LOCATION_BANNER: Record<
  LocationTrouble,
  { icon: string; message: StringKey }
> = {
  slow: { icon: "\u23F2", message: "live.locationSlow" },
  unavailable: { icon: "\u26A0", message: "live.locationUnavailable" },
};

interface LiveMidpointPageProps {
  /**
   * The session the link named, or `null` to create one. Read from the URL
   * once, by `App`, before anything here mounts: a live session writes its
   * code to the URL, so a re-run that read it again would try to *join* the
   * session its predecessor created.
   */
  urlCode: string | null;
  /**
   * The name typed on the start screen in this page load, "" if none. The
   * session reads the saved name for itself; this is for the browser that
   * would not save it.
   */
  initialName?: string;
}

/**
 * Auth gate — waits for Firebase Anonymous Auth before rendering inner page.
 *
 * Mounted by `App` only once the person has agreed to start or join, so
 * the sign-in below, and everything under it, follows that tap.
 */
export default function LiveMidpointPage({
  urlCode,
  initialName = "",
}: LiveMidpointPageProps) {
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

  return (
    <LiveMidpointInner
      uid={auth.uid}
      urlCode={urlCode}
      initialName={initialName}
    />
  );
}

/** Inner page — only renders after auth is resolved. */
function LiveMidpointInner({
  uid,
  urlCode,
  initialName,
}: {
  uid: string;
  urlCode: string | null;
  initialName: string;
}) {
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

  // ── Overlay footprint ──
  // The map runs full-bleed under the top bar and the sheet, so the camera
  // has to be told what they cover or it frames people underneath. Callback
  // refs held in state, so the measurement follows the elements themselves.
  const [pageEl, setPageEl] = useState<HTMLElement | null>(null);
  const [topbarEl, setTopbarEl] = useState<HTMLDivElement | null>(null);
  const [sheetEl, setSheetEl] = useState<HTMLDivElement | null>(null);
  const overlay = useOverlayInsets(pageEl, topbarEl, sheetEl);
  const overlayStyle = useMemo(
    () =>
      ({
        "--live-lift-left": `${overlay.liftLeft}px`,
        "--live-lift-right": `${overlay.liftRight}px`,
      }) as CSSProperties,
    [overlay.liftLeft, overlay.liftRight],
  );

  // Feed session and GPS state in. These are event streams, not graph nodes:
  // the graph derives from them, never the other way round.
  //
  // `ownPosition` comes straight from geolocation. It used to be mirrored
  // through `useLiveSession` — geo → updateOwnLocation → setOwnPosition →
  // render → setSources — which cost two commits per fix and let position and
  // accuracy in the same slot vector come from two different fixes, because
  // accuracy was already read directly from `geo`.
  //
  // Turning location off is turning sharing off: the denial clears the
  // position, and the presence node removes what it had published. So does a
  // session that is lost, expired or closed — it is the one place own position
  // is written and deleted. Transient GPS failures keep the last fix on
  // purpose.
  useEffect(() => {
    runtime.setSources({
      session: session.state,
      ownPosition: geo.position,
      ownAccuracy: geo.accuracy,
      participants: session.participants,
      peerPins: session.peerPins,
      ownUid: uid,
      ownName: session.ownName,
      serverTimeOffsetMs,
    });
  }, [
    runtime,
    uid,
    session.state,
    session.participants,
    session.peerPins,
    session.ownName,
    geo.position,
    geo.accuracy,
    serverTimeOffsetMs,
  ]);

  // Selection and travel mode live in the graph rather than in React state.
  // Mirroring them would give two sources of truth: the list would highlight
  // a venue the graph had already stopped routing to. The pick goes in as the
  // place itself, so the graph can keep it listed once a search stops
  // returning it.
  // Once a meeting point is set, picking a venue moves it there: the pick
  // alone would be this device's, and a destination nobody else had.
  const handleSelectVenue = useCallback(
    (venue: RankedVenue | null) => {
      runtime.setSources({ selectedPlace: venue });
      if (venue !== null && runtime.getSnapshot().pin !== null) {
        runtime.setMeetingPoint(venue.location, venue.displayName);
      }
    },
    [runtime],
  );

  // Going is the decision. The first Navigate fixes the destination where it
  // is, for everyone here: the live midpoint moved a kilometre for every two
  // the others drove, and went with whoever left the page first. Read from
  // the runtime, not from this render: the tap is what is current.
  const handleNavigate = useCallback(() => {
    const { pin, destination, selectedVenue } = runtime.getSnapshot();
    if (pin !== null || destination === null) return;
    runtime.setMeetingPoint(destination, selectedVenue?.displayName ?? null);
  }, [runtime]);

  const handleMovePin = useCallback(() => {
    const { midpoint } = runtime.getSnapshot();
    if (midpoint !== null) runtime.setMeetingPoint(midpoint, null);
  }, [runtime]);

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
      const isOwn = slot === slots.ownSlot;
      out.push({
        position,
        accuracy: slots.accuracy[slot] ?? 0,
        index: slot,
        isOwn,
        stale: slots.stale[slot] ?? false,
        label: isOwn ? null : participantInitial(slots.names[slot], slot),
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

  // Who set the meeting point, as the card names them: `null` for this
  // device. Their name as it is now while they are here, and as it was when
  // they set it once they have gone — which is usually the case.
  const { pin } = graph;
  const pinView = useMemo(() => {
    if (pin === null) return null;
    const setBy =
      pin.by === slots.ownSlot
        ? null
        : (slots.names[pin.by] ??
          pin.byName ??
          t("live.participant", { n: pin.by + 1 }));
    return { setBy, name: pin.name };
  }, [pin, slots]);

  // The live midpoint has wandered from the meeting point far enough to be
  // somewhere else: shown on the map, and offered as the new meeting point.
  const pinDrifted =
    pin !== null &&
    graph.midpoint !== null &&
    haversineDistance(pin.position, graph.midpoint) >= PIN_DRIFT_M;

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

  // The handshake returns a Result rather than throwing. It used to throw into
  // this effect with no `.catch()`, so every failed join raised an unhandled
  // rejection on top of the Sentry event the hook already recorded. The
  // controller cancels the retry loop if we unmount mid-handshake; both
  // handshakes check it before their first write, and the session drops any
  // late result from a handshake it is no longer waiting on.
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

  // The name from the start screen. Normally the session has read it from
  // storage already and this changes nothing; where storage is blocked it is
  // the only way the name arrives.
  const { setOwnName } = session;
  useEffect(() => {
    if (initialName !== "") setOwnName(initialName);
  }, [initialName, setOwnName]);

  // The agreement given on the start screen was to a session of one's own,
  // which had no code then. It has one now, and that is what a reload of this
  // tab will find in the URL.
  const liveCode = sessionCode(session.state);
  useEffect(() => {
    if (liveCode !== null) rememberConsent(liveCode);
  }, [liveCode]);

  // Own location no longer needs piping to Firebase from here: the graph's
  // `presence` node owns that write, with the debounce, admission control,
  // retry, timeout and breaker every other effectful node gets.

  // ── Leaving the page ──
  const closeRef = useRef(session.close);
  closeRef.current = session.close;
  const geoStopRef = useRef(geo.stop);
  geoStopRef.current = geo.stop;

  useEffect(() => {
    // `pagehide` only. It fires whenever the page really goes — closed,
    // navigated away, put in the back/forward cache — on iOS Safari too,
    // where `beforeunload` is unreliable. `beforeunload` exists so a page can
    // cancel a navigation, so it can fire for one that never happens, and it
    // used to tear down the listener and GPS of a page that stayed open.
    const handlePageHide = () => {
      // Synchronously: React would render after the page is gone. Pushed
      // straight into the graph, `closed` stops the presence node and
      // removes own position now, over the socket that is still open; the
      // render that follows pushes the same value, a no-op.
      runtime.setSources({ session: CLOSED_SESSION });
      closeRef.current();
      geoStopRef.current();
    };
    // Restored from the back/forward cache, the page comes back without the
    // listener and GPS that pagehide tore down, and nothing restarts them:
    // the map froze on its last frame. A reload rebuilds both.
    const handleShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handleShow);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handleShow);
      // Intentionally no teardown here. An unmount is not the page leaving:
      // StrictMode's dev cycle (mount → unmount → mount) runs this too. The
      // listener detaches with its own effect, and the graph's runtime removes
      // own position when it is disposed.
    };
  }, [runtime]);

  // Read own position back out of the slot vector rather than from a second
  // source: everything on screen is keyed by slot, and this is that index.
  const ownPosition =
    slots.ownSlot === null ? null : (slots.positions[slots.ownSlot] ?? null);

  // ── What to show ──
  // One pure function over the inputs, so the precedence is written down
  // once (screen.ts) instead of falling out of the order of the `if`s here.
  const screen = deriveScreen({
    phase: graph.phase,
    session: session.state,
    geo: geo.status,
    ownPosition,
    destination: graph.destination,
    pinned: graph.pin !== null,
    claimedSlots: session.claimedSlots,
    othersSeen: graph.seenSharing.filter(Boolean).length,
  });

  if (screen.kind === "ended") {
    return (
      <SessionErrorPanel
        errorCode={screen.failure.code}
        errorDetails={screen.failure.details}
      />
    );
  }

  if (screen.kind !== "map") {
    const location = LOCATION_SCREENS[screen.kind];
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon" aria-hidden="true">
            {"\u{1F4CD}"}
          </div>
          <div className="live-error-title">{t(location.title)}</div>
          <div className="live-error-message">{t(location.instructions)}</div>
          {/* The denied screen used to have no way out, and it is where a
              phone with its Location toggle off lands: Chrome reports that
              as PERMISSION_DENIED and offers its "turn on location" dialog
              only for a request made inside a tap, so a reload never
              recovers. Reload as well: WebKit (every iOS browser) fixes a
              page's denial for the page's lifetime, so there only a reload
              asks again — and an installed PWA has no reload control. */}
          {location.canRetry && (
            <div className="live-error-actions">
              <button
                type="button"
                className="live-btn live-btn-primary"
                onClick={() => geo.start()}
              >
                {t("common.retry")}
              </button>
              <button
                type="button"
                className="live-btn live-btn-secondary"
                onClick={() => window.location.reload()}
              >
                {t("app.reload")}
              </button>
            </div>
          )}
          {/* Open, so a screenshot of this screen carries the reason. */}
          {geo.error && (
            <details className="live-error-details" open>
              <summary>{t("live.errorDetails")}</summary>
              <code>{geo.error}</code>
            </details>
          )}
          {/* This is the screen that asks for location: what happens to it
              has to be one tap away. */}
          <LegalLinks />
        </div>
      </div>
    );
  }

  const ownIndex = sessionSlot(session.state) ?? (0 as ParticipantIndex);

  const renderSheet = (sheet: Sheet): ReactNode => {
    switch (sheet.kind) {
      case "none":
        return null;
      // Until the database holds the session there is nothing to share and
      // nobody to wait for, and a bare map said neither. A joiner sat on one
      // for as long as its handshake took — forever, on a device that could
      // not connect — and a creator would too, now that its code appears
      // only once the session is written.
      case "creating":
      case "joining":
        return (
          <div
            className="live-card live-glass live-waiting-shimmer live-handshake"
            role="status"
          >
            {t(sheet.kind === "creating" ? "live.creating" : "live.connecting")}
          </div>
        );
      case "waiting":
        return <WaitingCard code={sheet.code} full={sheet.full} />;
      // The others are on the map already; "Waiting for others to join" is
      // what this said, while the one missing was this phone's own fix.
      case "locating":
        return (
          <div
            className="live-card live-glass live-waiting-shimmer live-handshake"
            role="status"
          >
            {t("live.locating")}
          </div>
        );
      case "meeting":
        return (
          <>
            {placesEnabled && (
              <Suspense fallback={null}>
                <VenueListCard
                  venues={graph.venues}
                  status={graph.venueStatus}
                  selectedVenue={graph.selectedVenue}
                  onSelectVenue={handleSelectVenue}
                />
              </Suspense>
            )}
            <MidpointCard
              ownIndex={ownIndex}
              ownPosition={sheet.ownPosition}
              ownRoute={routes[ownIndex] ?? null}
              otherParticipants={otherParticipants}
              destination={sheet.destination}
              travelProfile={graph.travelProfile}
              onProfileChange={handleProfileChange}
              selectedVenueName={graph.selectedVenue?.displayName ?? null}
              routesStale={graph.routesDegraded}
              pin={pinView}
              onMovePin={pinDrifted ? handleMovePin : null}
              onNavigate={handleNavigate}
            />
          </>
        );
    }
  };

  return (
    <main className="live-page" ref={setPageEl} style={overlayStyle}>
      {/* The same box the map will fill, so nothing moves when it does. */}
      <Suspense fallback={<div className="live-map-container" />}>
        <LiveMap
          participants={mapParticipants}
          midpoint={graph.midpoint}
          routes={routeGeometries}
          venues={graph.venues}
          selectedVenue={graph.selectedVenue}
          pinned={graph.pin?.position ?? null}
          insets={overlay.insets}
        />
      </Suspense>

      {/* Everything drawn over the top of the map. Measured, like the sheet:
          an overlay outside these two is one the camera cannot see. */}
      <div className="live-topbar" ref={setTopbarEl}>
        {screen.code && (
          <SessionBadge
            code={screen.code}
            phase={graph.phase}
            ownConnected={geo.status === "watching"}
            ownIndex={ownIndex}
            ownName={session.ownName}
            onNameChange={session.setOwnName}
            canInvite={screen.canInvite}
            participants={badgeParticipants}
          />
        )}

        {networkStatus.connectivity !== "online" && (
          <div className="live-offline-banner" role="status">
            <span aria-hidden="true">&#9888;</span>
            {t(CONNECTIVITY_BANNER[networkStatus.connectivity])}
          </div>
        )}

        {/* The graph knew, and nothing said so: the others saw this
            participant go stale while their own screen looked fine. A lost
            connection already has its banner. */}
        {networkStatus.connectivity === "online" && graph.presenceFailed && (
          <div className="live-offline-banner" role="status">
            <span aria-hidden="true">&#9888;</span>
            {t("live.presenceFailed")}
          </div>
        )}

        {screen.locationTrouble !== null && (
          <div className="live-offline-banner" role="status">
            <span aria-hidden="true">
              {LOCATION_BANNER[screen.locationTrouble].icon}
            </span>
            {t(LOCATION_BANNER[screen.locationTrouble].message)}
          </div>
        )}
      </div>

      <div className="live-sheet" ref={setSheetEl}>
        {renderSheet(screen.sheet)}
        {/* Anyone who holds a slot can read every position, and a device
            that shares none of its own is on nobody's map. */}
        {screen.unseenDevices > 0 && (
          <p className="live-card live-glass live-sheet-note" role="status">
            {screen.unseenDevices === 1
              ? t("live.unseenDeviceOne")
              : t("live.unseenDeviceMany", { count: screen.unseenDevices })}
          </p>
        )}
        {/* Under every card, not only the waiting one: a joiner never sees
            that card. */}
        {screen.sheet.kind !== "none" && <LegalLinks />}
      </div>
    </main>
  );
}
