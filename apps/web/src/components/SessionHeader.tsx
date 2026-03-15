import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

interface SessionHeaderProps {
  participantCount: number;
  maxParticipants: number;
  status: string;
  sessionId: string;
  locationCount?: number;
}

/** Session status bar with participant count, WhatsApp share, and clipboard fallback. RTL-aware. */
export default function SessionHeader({
  participantCount,
  maxParticipants,
  status,
  sessionId,
  locationCount,
}: SessionHeaderProps) {
  const { t } = useTranslation();
  const [toast, setToast] = useState<string | null>(null);

  const shareUrl = `${window.location.origin}?session=${sessionId}`;
  const shareText = t("session.shareMessage", { url: shareUrl });

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  /** Primary: WhatsApp deep link */
  const handleWhatsApp = useCallback(() => {
    const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    window.open(waUrl, "_blank", "noopener");
  }, [shareText]);

  /** Secondary: Web Share API → clipboard fallback */
  const handleShare = useCallback(async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: t("app.title"), url: shareUrl });
        return;
      }
    } catch (err) {
      // User cancelled share sheet — not an error
      if (err instanceof Error && err.name === "AbortError") return;
    }

    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast(t("session.shareCopied"));
    } catch {
      // Clipboard API unavailable — fallback prompt
      prompt(t("session.share"), shareUrl);
    }
  }, [shareUrl, t, showToast]);

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
        {locationCount !== undefined && (
          <span className="text-xs text-gray-500">
            {t("session.locationsReceived", {
              count: locationCount,
              total: participantCount,
            })}
          </span>
        )}
      </div>

      {/* Share actions */}
      <div className="flex items-center gap-2">
        {/* WhatsApp button */}
        <button
          type="button"
          onClick={handleWhatsApp}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#25D366] rounded-full hover:bg-[#20bd5a] transition-colors"
          aria-label={t("session.shareWhatsApp")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
          WhatsApp
        </button>

        {/* Generic share / copy button */}
        <button
          type="button"
          onClick={handleShare}
          className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
          aria-label={t("session.share")}
        >
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
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
        </button>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="share-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
