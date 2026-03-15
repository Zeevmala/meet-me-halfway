import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import "./lib/i18n";
import JoinFlow from "./components/JoinFlow";
import LanguageSwitcher from "./components/LanguageSwitcher";
import Map from "./components/Map";
import SessionHeader from "./components/SessionHeader";
import VenueList from "./components/VenueList";
import type { ParticipantRTDB } from "./hooks/useFirebase";
import { useParticipantLocations } from "./hooks/useFirebase";
import { MapSelectionProvider } from "./hooks/useMapSelection";
import { useNetworkStatus } from "./hooks/useNetworkStatus";
import { useSession } from "./hooks/useSession";
import { voteVenue } from "./lib/api";

/** Retrieve saved participant ID — only if it matches the current session */
function getSavedParticipantId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const saved = sessionStorage.getItem("joined_session");
  if (saved === sessionId) return sessionStorage.getItem("participant_id");
  return null;
}

export default function App() {
  const { t } = useTranslation();
  const online = useNetworkStatus();
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  const { session, midpoint, loading, error } = useSession(sessionId);
  const firebaseParticipants = useParticipantLocations(sessionId);
  const [sheetHeight, setSheetHeight] = useState(72);
  const [participantId, setParticipantId] = useState<string | null>(() =>
    getSavedParticipantId(sessionId),
  );

  /** Called when user completes the join flow */
  const handleJoined = useCallback((pid: string) => {
    setParticipantId(pid);
  }, []);

  // Use Firebase participants if available (real-time), fall back to API data
  const hasFirebase = Object.keys(firebaseParticipants).length > 0;
  const participants: Record<string, ParticipantRTDB> = hasFirebase
    ? firebaseParticipants
    : Object.fromEntries(
        (midpoint?.participants ?? []).map((p) => [
          p.participant_id,
          {
            lat: p.lat,
            lng: p.lng,
            display_name: p.display_name,
            updated_at: "",
          },
        ]),
      );

  const handleVenueVote = useCallback(
    async (placeId: string) => {
      if (!sessionId) return;
      const venue = midpoint?.venues.find((v) => v.place_id === placeId);
      if (!venue) return;
      if (!participantId) return;
      try {
        await voteVenue(sessionId, {
          participant_id: participantId,
          place_id: placeId,
          venue_name: venue.name,
          venue_lat: venue.lat,
          venue_lng: venue.lng,
        });
      } catch {
        /* vote failed silently — next poll will update */
      }
    },
    [sessionId, midpoint, participantId],
  );

  // ── Loading skeleton ──
  if (loading && !session) {
    return (
      <div className="flex flex-col h-screen">
        <header className="bg-white shadow z-10 px-4 py-3 flex items-center">
          <div className="skeleton h-5 w-40" />
          <div className="ms-auto skeleton h-5 w-20" />
        </header>
        <div className="skeleton h-8 mx-4 mt-2 w-48" />
        <main className="flex-1 relative overflow-hidden">
          <div className="absolute inset-0 bg-gray-100 animate-pulse" />
          <div className="absolute bottom-0 left-0 right-0 h-[72px] bg-white/90 rounded-t-2xl shadow-xl">
            <div className="flex flex-col items-center gap-2 pt-3">
              <div className="w-9 h-1 bg-gray-300 rounded" />
              <div className="skeleton h-3 w-32" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── Error state ──
  if (error && !session) {
    return (
      <div className="flex flex-col h-screen">
        <header className="bg-white shadow z-10 px-4 py-3 flex items-center">
          <h1 className="text-xl font-bold text-gray-900">{t("app.title")}</h1>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z"
              />
            </svg>
          </div>
          <p className="text-sm text-gray-600">
            {error === "expired" ? t("session.expired") : t("session.error")}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <MapSelectionProvider>
      <div className="flex flex-col h-screen">
        <header className="bg-white shadow z-10 px-4 py-3 flex items-center">
          <h1 className="text-xl font-bold text-gray-900">{t("app.title")}</h1>
          <div className="ms-auto">
            <LanguageSwitcher />
          </div>
        </header>

        {/* Offline banner */}
        {!online && (
          <div className="offline-banner">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
              <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
              <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
              <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
              <line x1="12" y1="20" x2="12.01" y2="20" />
            </svg>
            {t("app.offline")}
          </div>
        )}

        {session && (
          <SessionHeader
            participantCount={session.participant_count}
            maxParticipants={session.max_participants}
            status={session.status}
            sessionId={session.session_id}
            locationCount={Object.keys(participants).length}
          />
        )}

        <main className="flex-1 relative overflow-hidden">
          <Map
            participants={participants}
            centroid={midpoint?.centroid ?? null}
            venues={midpoint?.venues ?? []}
            sheetHeight={sheetHeight}
          />

          {/* Join flow overlay — show when session active + user not yet joined */}
          {session &&
            !participantId &&
            session.status === "active" &&
            sessionId && (
              <JoinFlow sessionId={sessionId} onJoined={handleJoined} />
            )}

          {/* Midpoint loading overlay */}
          {session && !midpoint && !loading && (
            <div className="midpoint-loading">
              <div className="midpoint-loading-card">
                <div className="midpoint-spinner" />
                <span className="text-sm font-medium text-gray-700">
                  {t("map.findingMidpoint")}
                </span>
              </div>
            </div>
          )}

          <VenueList
            venues={midpoint?.venues ?? []}
            onVenueVote={handleVenueVote}
            onHeightChange={setSheetHeight}
          />
        </main>
      </div>
    </MapSelectionProvider>
  );
}
