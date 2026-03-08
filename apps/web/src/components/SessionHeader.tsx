import { useTranslation } from "react-i18next";

interface SessionHeaderProps {
  participantCount: number;
  maxParticipants: number;
  status: string;
  sessionId: string;
}

/** Session status bar with participant count and share link button. RTL-aware. */
export default function SessionHeader({
  participantCount,
  maxParticipants,
  status,
  sessionId,
}: SessionHeaderProps) {
  const { t } = useTranslation();

  const shareUrl = `${window.location.origin}?session=${sessionId}`;

  async function handleShare() {
    if (navigator.share) {
      await navigator.share({ title: t("app.title"), url: shareUrl });
    } else {
      await navigator.clipboard.writeText(shareUrl);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 bg-white border-b border-gray-100">
      {/* Participant count — logical margin for RTL */}
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 font-semibold text-xs">
          {participantCount}
        </span>
        <span>
          {t("session.participantCount", {
            count: participantCount,
            max: maxParticipants,
          })}
        </span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            status === "active"
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {t(`session.status.${status}`, status)}
        </span>
      </div>

      {/* Share button — inline-end margin so it sits at the logical end in both LTR and RTL */}
      <button
        onClick={handleShare}
        className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
        aria-label={t("session.share")}
      >
        {t("session.share")}
      </button>
    </div>
  );
}
