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
import { sphericalMidpoint } from "./lib/geo-math";
import { normalizeCode, isValidCode } from "./lib/session-code";
import LiveMap from "./components/LiveMap";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import VenueListCard from "./components/VenueListCard";
import LanguageSwitcher from "../../components/LanguageSwitcher";
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

  // Determine positions for A and B based on role
  const posA =
    session.role === "a" ? session.ownPosition : session.partnerPosition;
  const posB =
    session.role === "b" ? session.ownPosition : session.partnerPosition;

  // Compute midpoint when both positions available
  const midpoint = useMemo(() => {
    if (!posA || !posB) return null;
    return sphericalMidpoint(posA, posB);
  }, [posA, posB]);

  // Venue search + selection state
  const [selectedVenue, setSelectedVenue] = useState<RankedVenue | null>(null);
  const [travelProfile, setTravelProfile] = useState<TravelProfile>("driving");
  const venueSearch = useVenueSearch(midpoint);

  // Destination: selected venue or midpoint
  const destination = selectedVenue ? selectedVenue.location : midpoint;

  // Fetch dual routes with 3s debounce + 200m movement threshold
  const { routeA, routeB } = useDirections(
    posA,
    posB,
    destination,
    travelProfile,
  );

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

  // Derive accuracy values for A and B based on role
  const accuracyA =
    session.role === "a"
      ? (geo.accuracy ?? null)
      : (session.partnerAccuracy ?? null);
  const accuracyB =
    session.role === "b"
      ? (geo.accuracy ?? null)
      : (session.partnerAccuracy ?? null);
  const partnerStale = session.phase === "partner_stale";

  const isConnected =
    session.phase === "connected" || session.phase === "partner_stale";

  return (
    <div className="live-page">
      <LiveMap
        posA={posA}
        posB={posB}
        midpoint={midpoint}
        routeA={routeA?.geometry ?? null}
        routeB={routeB?.geometry ?? null}
        role={session.role}
        accuracyA={accuracyA}
        accuracyB={accuracyB}
        partnerStale={partnerStale}
        venues={venueSearch.venues}
        selectedVenue={selectedVenue}
      />

      {/* Language switcher in top-right corner */}
      <div
        style={{
          position: "absolute",
          top: "max(12px, env(safe-area-inset-top, 12px))",
          insetInlineEnd: "12px",
          zIndex: 15,
        }}
      >
        <LanguageSwitcher />
      </div>

      {session.code && (
        <SessionBadge
          code={session.code}
          phase={session.phase}
          ownConnected={geo.status === "watching"}
          partnerConnected={session.partnerPosition !== null}
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

      {isConnected && midpoint && posA && posB && (
        <div className="live-bottom-panel">
          <VenueListCard
            venues={venueSearch.venues}
            loading={venueSearch.loading}
            selectedVenue={selectedVenue}
            onSelectVenue={setSelectedVenue}
          />
          <MidpointCard
            midpoint={midpoint}
            posA={posA}
            posB={posB}
            routeA={routeA}
            routeB={routeB}
            partnerStale={session.phase === "partner_stale"}
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
