import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/useAuth";
import { useNetworkStatus } from "../../hooks/useNetworkStatus";
import { useLiveGeolocation } from "./hooks/useLiveGeolocation";
import { useLiveSession } from "./hooks/useLiveSession";
import type { SessionErrorCode } from "./hooks/useLiveSession";
import { useDirections } from "./hooks/useDirections";
import type { TravelProfile } from "./hooks/useDirections";
import { useVenueSearch } from "./hooks/useVenueSearch";
import type { RankedVenue } from "./lib/venue-ranking";
import { geographicCentroid } from "./lib/geo-math";
import type { LatLng } from "./lib/geo-math";
import { normalizeCode, isValidCode } from "./lib/session-code";
import type { ParticipantIndex } from "./lib/participant-config";
import LiveMap from "./components/LiveMap";
import type { MapParticipant } from "./components/LiveMap";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import VenueListCard from "./components/VenueListCard";
import "./styles/live-midpoint.css";

/** Map session error codes to i18n keys. */
const SESSION_ERROR_I18N: Record<SessionErrorCode, string> = {
  SESSION_NOT_FOUND: "live.sessionNotFound",
  SESSION_FULL: "live.sessionFull",
  SESSION_EXPIRED: "live.sessionExpired",
  CREATE_FAILED: "live.geoError",
  JOIN_FAILED: "live.geoError",
  CONNECTION_ERROR: "live.geoError",
};

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
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#9888;</div>
          <div className="live-error-title">{t("live.authError")}</div>
          <div className="live-error-message">{auth.error}</div>
        </div>
      </div>
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

  // Build ordered positions array: own position first, then others
  const allPositions: (LatLng | null)[] = useMemo(() => {
    const others = session.participants.map((p) => p.position);
    return [session.ownPosition, ...others];
  }, [session.ownPosition, session.participants]);

  // Compute geographic centroid when 2+ positions available
  const midpoint = useMemo(() => {
    const valid = allPositions.filter((p): p is LatLng => p !== null);
    if (valid.length < 2) return null;
    return geographicCentroid(valid);
  }, [allPositions]);

  // Venue search + selection state
  const [selectedVenue, setSelectedVenue] = useState<RankedVenue | null>(null);
  const [travelProfile, setTravelProfile] = useState<TravelProfile>("driving");
  const venueSearch = useVenueSearch(midpoint);

  // Destination: selected venue or midpoint
  const destination = selectedVenue ? selectedVenue.location : midpoint;

  // Fetch routes for all participants with 3s debounce + 200m movement threshold
  const { routes } = useDirections(allPositions, destination, travelProfile);

  // ── Clear venue selection if venue disappears from refreshed list ──
  useEffect(() => {
    if (selectedVenue && venueSearch.venues.length > 0) {
      const stillPresent = venueSearch.venues.some(
        (v) => v.id === selectedVenue.id,
      );
      if (!stillPresent) setSelectedVenue(null);
    }
  }, [venueSearch.venues, selectedVenue]);

  // ── Initialize: start geolocation, then create or join session ──
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    geo.start();

    const urlCode = getCodeFromURL();
    if (urlCode) {
      session.joinSession(urlCode);
    } else {
      session.createSession();
    }
    // Intentionally run once on mount
  }, []);

  // ── Pipe geolocation updates to Firebase ──
  useEffect(() => {
    if (geo.position && geo.accuracy !== null) {
      session.updateOwnLocation(geo.position, geo.accuracy);
    }
  }, [geo.position, geo.accuracy, session.updateOwnLocation]);

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
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      handleUnload();
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

  if (session.phase === "error") {
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#9888;</div>
          <div className="live-error-title">
            {t(
              session.error
                ? SESSION_ERROR_I18N[session.error]
                : "live.geoError",
            )}
          </div>
        </div>
      </div>
    );
  }

  const ownIndex = session.ownIndex ?? (0 as ParticipantIndex);

  const isConnected =
    session.phase === "connected" || session.phase === "some_stale";

  // Build map participants array
  const mapParticipants: MapParticipant[] = [];
  if (session.ownPosition) {
    mapParticipants.push({
      position: session.ownPosition,
      accuracy: geo.accuracy ?? 0,
      index: ownIndex,
      isOwn: true,
      stale: false,
    });
  }
  for (const p of session.participants) {
    mapParticipants.push({
      position: p.position,
      accuracy: p.accuracy,
      index: p.index,
      isOwn: false,
      stale: p.stale,
    });
  }

  // Build route geometries array (parallel to allPositions)
  const routeGeometries = routes.map((r) => r?.geometry ?? null);

  // Build badge participants
  const badgeParticipants = session.participants.map((p) => ({
    index: p.index,
    connected: true,
  }));

  // Build MidpointCard other-participants
  const otherParticipants = session.participants.map((p, i) => ({
    index: p.index,
    route: routes[i + 1] ?? null, // routes[0] is own, others start at 1
    position: p.position,
    stale: p.stale,
  }));

  return (
    <div className="live-page">
      <LiveMap
        participants={mapParticipants}
        midpoint={midpoint}
        routes={routeGeometries}
        venues={venueSearch.venues}
        selectedVenue={selectedVenue}
      />

      {session.code && (
        <SessionBadge
          code={session.code}
          phase={session.phase}
          ownConnected={geo.status === "watching"}
          ownIndex={ownIndex}
          participants={badgeParticipants}
        />
      )}

      {!networkStatus.isOnline && (
        <div className="live-offline-banner">
          <span>&#9888;</span>
          {t("app.offline")}
        </div>
      )}

      {session.phase === "waiting" && session.code && (
        <WaitingCard code={session.code} />
      )}

      {isConnected && midpoint && session.ownPosition && (
        <div className="live-bottom-panel">
          <VenueListCard
            venues={venueSearch.venues}
            loading={venueSearch.loading}
            selectedVenue={selectedVenue}
            onSelectVenue={setSelectedVenue}
          />
          <MidpointCard
            midpoint={midpoint}
            ownIndex={ownIndex}
            ownPosition={session.ownPosition}
            ownRoute={routes[0] ?? null}
            otherParticipants={otherParticipants}
            destination={destination ?? midpoint}
            travelProfile={travelProfile}
            onProfileChange={setTravelProfile}
            selectedVenueName={selectedVenue?.displayName ?? null}
          />
        </div>
      )}
    </div>
  );
}
