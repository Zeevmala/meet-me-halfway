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
import { sessionSlot } from "./graph/nodes";
import type { OtherParticipantView, TravelProfile } from "./graph/types";
import { deriveScreen } from "./screen";
import type { LocationTrouble, Screen, Sheet } from "./screen";
import type { RankedVenue } from "./lib/venue-ranking";
import { normalizeCode } from "./lib/session-code";
import { participantInitial } from "./lib/display-name";
import type { ParticipantIndex } from "./lib/participant-config";
import LiveMap from "./components/LiveMap";
import type { MapParticipant } from "./components/LiveMap";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import SessionErrorPanel from "./components/SessionErrorPanel";
import { pendingWhileReloading } from "../../lib/stale-chunk-reload";
import "./styles/live-midpoint.css";

// Lazy-load VenueListCard — only needed when Places API key is configured
const VenueListCard = lazy(
  pendingWhileReloading(() => import("./components/VenueListCard")),
);

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
      ownUid: uid,
      ownName: session.ownName,
      serverTimeOffsetMs,
    });
  }, [
    runtime,
    uid,
    session.state,
    session.participants,
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
  const handleSelectVenue = useCallback(
    (venue: RankedVenue | null) => {
      runtime.setSources({ selectedPlace: venue });
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

  // Read once per mount, not inside the effect: a live session writes its
  // code to the URL, so a re-run that read it again could try to *join* a
  // session its predecessor created.
  const [urlCode] = useState(getCodeFromURL);

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
    midpoint: graph.midpoint,
    claimedSlots: session.claimedSlots,
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
              destination={graph.destination ?? sheet.midpoint}
              travelProfile={graph.travelProfile}
              onProfileChange={handleProfileChange}
              selectedVenueName={graph.selectedVenue?.displayName ?? null}
              routesStale={graph.routesDegraded}
            />
          </>
        );
    }
  };

  return (
    <main className="live-page" ref={setPageEl} style={overlayStyle}>
      <LiveMap
        participants={mapParticipants}
        midpoint={graph.midpoint}
        routes={routeGeometries}
        venues={graph.venues}
        selectedVenue={graph.selectedVenue}
        insets={overlay.insets}
      />

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
      </div>
    </main>
  );
}
