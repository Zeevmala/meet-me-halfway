import { useTranslation } from "react-i18next";
import "./lib/i18n"; // initializes i18next + applies document.dir
import LanguageSwitcher from "./components/LanguageSwitcher";
import Map from "./components/Map";
import SessionHeader from "./components/SessionHeader";
import VenueList from "./components/VenueList";
import { useParticipantLocations } from "./hooks/useFirebase";
import { useSession } from "./hooks/useSession";

export default function App() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  const { session, midpoint, loading, error } = useSession(sessionId);
  const participants = useParticipantLocations(sessionId);

  return (
    <div className="flex flex-col h-screen">
      <header className="bg-white shadow z-10 px-4 py-3 flex items-center">
        <h1 className="text-xl font-bold text-gray-900">{t("app.title")}</h1>
        <div className="ms-auto">
          <LanguageSwitcher />
        </div>
      </header>

      {session && (
        <SessionHeader
          participantCount={session.participant_count}
          maxParticipants={session.max_participants}
          status={session.status}
          sessionId={session.session_id}
        />
      )}

      {loading && (
        <div className="px-4 py-2 text-sm text-gray-500">
          {t("session.loading")}
        </div>
      )}
      {error && (
        <div className="px-4 py-2 text-sm text-red-600">
          {t("session.error")}
        </div>
      )}

      <main className="flex-1 relative overflow-hidden">
        <Map
          participants={participants}
          centroid={midpoint?.centroid ?? null}
          venues={midpoint?.venues ?? []}
        />
        <VenueList venues={midpoint?.venues ?? []} />
      </main>
    </div>
  );
}
