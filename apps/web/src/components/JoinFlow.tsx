import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGeolocation } from "../hooks/useGeolocation";
import type { GeolocationStatus } from "../hooks/useGeolocation";
import { joinSession } from "../lib/api";

interface JoinFlowProps {
  sessionId: string;
  onJoined: (participantId: string) => void;
}

/**
 * Frosted-glass overlay for joining a session.
 * Collects display name + browser geolocation, then POSTs to /sessions/{id}/join.
 * Stores participant_id in sessionStorage on success.
 */
export default function JoinFlow({ sessionId, onJoined }: JoinFlowProps) {
  const { t } = useTranslation();
  const geo = useGeolocation();
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canJoin =
    name.trim().length > 0 && geo.status === "granted" && geo.position !== null;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canJoin || !geo.position) return;

      setJoining(true);
      setError(null);

      try {
        const result = await joinSession(sessionId, {
          display_name: name.trim(),
          location: { lat: geo.position.lat, lng: geo.position.lng },
        });

        // Persist join state scoped to this session
        sessionStorage.setItem("participant_id", result.participant_id);
        sessionStorage.setItem("joined_session", result.session_id);

        onJoined(result.participant_id);
      } catch (err) {
        if (err instanceof Error && err.message.includes("409")) {
          setError(t("join.sessionFull"));
        } else {
          setError(t("join.error"));
        }
        setJoining(false);
      }
    },
    [canJoin, geo.position, sessionId, name, onJoined, t],
  );

  return (
    <div className="join-overlay">
      <form className="join-card" onSubmit={handleSubmit}>
        {/* Header */}
        <div className="join-card-header">
          <div className="join-card-icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </div>
          <h2 className="join-card-title">{t("join.title")}</h2>
          <p className="join-card-subtitle">{t("join.subtitle")}</p>
        </div>

        {/* Name input */}
        <input
          type="text"
          className="join-input"
          placeholder={t("join.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          autoFocus
          autoComplete="name"
        />

        {/* Location button */}
        <LocationButton
          status={geo.status}
          accuracy={geo.accuracy}
          error={geo.error}
          onRequest={geo.requestLocation}
        />

        {/* Submit */}
        <button
          type="submit"
          className={`join-submit ${joining ? "join-submit-loading" : ""}`}
          disabled={!canJoin || joining}
        >
          {joining ? t("join.joining") : t("join.joinButton")}
        </button>

        {/* Error */}
        {error && <p className="join-error">{error}</p>}
      </form>
    </div>
  );
}

/** Location button with visual status feedback */
function LocationButton({
  status,
  accuracy,
  error,
  onRequest,
}: {
  status: GeolocationStatus;
  accuracy: number | null;
  error: string | null;
  onRequest: () => void;
}) {
  const { t } = useTranslation();

  const statusClass =
    status === "requesting"
      ? "join-location-btn-requesting"
      : status === "granted"
        ? "join-location-btn-granted"
        : status === "denied"
          ? "join-location-btn-denied"
          : status === "error"
            ? "join-location-btn-error"
            : "";

  const statusText =
    status === "requesting"
      ? t("join.locating")
      : status === "granted"
        ? `${t("join.locationGranted")}${accuracy ? ` (${Math.round(accuracy)}m)` : ""}`
        : status === "denied"
          ? t("join.locationDenied")
          : status === "error"
            ? (error ?? t("join.locationError"))
            : status === "unavailable"
              ? t("join.locationUnavailable")
              : t("join.shareLocation");

  return (
    <button
      type="button"
      className={`join-location-btn ${statusClass}`}
      onClick={onRequest}
      disabled={
        status === "requesting" ||
        status === "granted" ||
        status === "unavailable"
      }
    >
      {status === "requesting" ? (
        <span className="join-location-spinner" />
      ) : status === "granted" ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : status === "denied" || status === "error" ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      )}
      <span>{statusText}</span>
    </button>
  );
}
