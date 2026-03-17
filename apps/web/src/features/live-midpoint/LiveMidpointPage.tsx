import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLiveGeolocation } from "./hooks/useLiveGeolocation";
import { useLiveSession } from "./hooks/useLiveSession";
import { useDirections } from "./hooks/useDirections";
import { sphericalMidpoint } from "./lib/geo-math";
import { normalizeCode, isValidCode } from "./lib/session-code";
import LiveMap from "./components/LiveMap";
import SessionBadge from "./components/SessionBadge";
import WaitingCard from "./components/WaitingCard";
import MidpointCard from "./components/MidpointCard";
import LanguageSwitcher from "../../components/LanguageSwitcher";
import "./styles/live-midpoint.css";

/** Read ?code= from URL query string. */
function getCodeFromURL(): string | null {
  const raw = new URLSearchParams(window.location.search).get("code");
  if (!raw) return null;
  const code = normalizeCode(raw);
  return isValidCode(code) ? code : null;
}

export default function LiveMidpointPage() {
  const { t } = useTranslation();
  const geo = useLiveGeolocation();
  const session = useLiveSession();
  const [, setInitialized] = useState(false);

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

  // Fetch dual routes with 3s debounce
  const { routeA, routeB } = useDirections(posA, posB, midpoint);

  // ── Initialize: start geolocation, then create or join session ──
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    geo.start();

    const urlCode = getCodeFromURL();
    if (urlCode) {
      // Joining an existing session
      session.joinSession(urlCode).then(() => setInitialized(true));
    } else {
      // Creating a new session
      session.createSession().then(() => setInitialized(true));
    }
    // Intentionally run once on mount
  }, []);

  // ── Pipe geolocation updates to Firebase ──
  useEffect(() => {
    if (geo.position && geo.accuracy !== null) {
      session.updateOwnLocation(geo.position, geo.accuracy);
    }
  }, [geo.position, geo.accuracy]);

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

  if (session.phase === "error") {
    return (
      <div className="live-page">
        <div className="live-error">
          <div className="live-error-icon">&#9888;</div>
          <div className="live-error-title">
            {session.error === "Session not found."
              ? t("live.sessionNotFound")
              : session.error === "Session already has two participants."
                ? t("live.sessionFull")
                : t("live.geoError")}
          </div>
          <div className="live-error-message">{session.error}</div>
        </div>
      </div>
    );
  }

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

      {session.phase === "waiting" && session.code && (
        <WaitingCard code={session.code} />
      )}

      {isConnected && midpoint && posA && posB && (
        <MidpointCard
          midpoint={midpoint}
          posA={posA}
          posB={posB}
          routeA={routeA}
          routeB={routeB}
          partnerStale={session.phase === "partner_stale"}
        />
      )}
    </div>
  );
}
