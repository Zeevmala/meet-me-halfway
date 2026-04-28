import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import { wazeLink, googleMapsLink } from "../lib/nav-links";
import type { RouteInfo, TravelProfile } from "../hooks/useDirections";
import type { ParticipantIndex } from "../lib/participant-config";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import "../styles/live-midpoint.css";

interface OtherParticipant {
  index: ParticipantIndex;
  route: RouteInfo | null;
  position: LatLng;
  stale: boolean;
  name: string | null;
}

interface MidpointCardProps {
  midpoint: LatLng;
  ownIndex: ParticipantIndex;
  ownPosition: LatLng;
  ownRoute: RouteInfo | null;
  otherParticipants: OtherParticipant[];
  destination: LatLng;
  travelProfile: TravelProfile;
  onProfileChange: (profile: TravelProfile) => void;
  selectedVenueName: string | null;
  code: string;
  participantCount: number;
}

function formatDuration(seconds: number): string {
  return String(Math.ceil(seconds / 60));
}

/** Bottom card shown when participants are connected. */
export default memo(function MidpointCard({
  midpoint,
  ownIndex,
  ownPosition,
  ownRoute,
  otherParticipants,
  destination,
  travelProfile,
  onProfileChange,
  selectedVenueName,
  code,
  participantCount,
}: MidpointCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}?code=${code}`;
  const canInvite = participantCount < MAX_PARTICIPANTS;

  // navigator.share exists on desktop Chrome but only works on mobile/HTTPS
  // with transient user activation. Use canShare() to guard properly.
  const canNativeShare =
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ url: shareUrl });

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(t("live.shareMessage", { url: shareUrl }))}`;

  const handleNativeShare = useCallback(async () => {
    try {
      await navigator.share({
        title: t("app.title"),
        text: t("live.shareMessage", { url: shareUrl }),
        url: shareUrl,
      });
    } catch (err: unknown) {
      // AbortError = user cancelled — ignore
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Any other error (NotAllowedError, etc.) — fall back to clipboard
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        window.prompt(t("live.copyLink"), shareUrl);
      }
    }
  }, [shareUrl, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("live.copyLink"), shareUrl);
    }
  }, [shareUrl, t]);

  const timeKey =
    travelProfile === "walking" ? "live.walkTime" : "live.driveTime";

  const staleParticipants = otherParticipants.filter((p) => p.stale);

  return (
    <div className="live-card live-glass">
      {staleParticipants.length > 0 && (
        <div className="live-stale-warning">
          <span>&#9888;</span>
          <div>
            {staleParticipants.map((p) => (
              <div key={p.index}>
                {p.name
                  ? t("live.participantStaleNamed", { name: p.name })
                  : t("live.participantStale", { n: p.index + 1 })}
              </div>
            ))}
            <div className="live-stale-hint">
              {t("live.participantStaleHint")}
            </div>
          </div>
        </div>
      )}

      {selectedVenueName && (
        <div className="live-destination-name">
          {t("live.meetAt", { name: selectedVenueName })}
        </div>
      )}

      <div className="live-profile-toggle">
        <button
          type="button"
          aria-pressed={travelProfile === "driving"}
          className={`live-profile-btn${travelProfile === "driving" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("driving")}
        >
          {t("live.driving")}
        </button>
        <button
          type="button"
          aria-pressed={travelProfile === "walking"}
          className={`live-profile-btn${travelProfile === "walking" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("walking")}
        >
          {t("live.walking")}
        </button>
      </div>

      {/* Your distance — full width */}
      <div className="live-stats live-stats--own">
        <div className="live-stat">
          <div className="live-stat-label">{t("live.yourDistance")}</div>
          <div className={`live-stat-value live-stat-value--p${ownIndex}`}>
            {ownRoute
              ? formatDistance(ownRoute.distance)
              : formatDistance(haversineDistance(ownPosition, midpoint))}
          </div>
          {ownRoute && (
            <div className="live-stat-sub">
              {t(timeKey, { minutes: formatDuration(ownRoute.duration) })}
            </div>
          )}
        </div>
      </div>

      {/* Other participants' distances */}
      {otherParticipants.length > 0 && (
        <div className="live-participant-list">
          <div className="live-stats">
            {otherParticipants.map((p) => (
              <div key={p.index} className="live-stat">
                <div className="live-stat-label">
                  <span
                    className={`live-stat-dot live-stat-dot--p${p.index}`}
                  />
                  {p.name
                    ? t("live.participantDistanceNamed", { name: p.name })
                    : t("live.participantDistance", { n: p.index + 1 })}
                </div>
                <div className={`live-stat-value live-stat-value--p${p.index}`}>
                  {p.route
                    ? formatDistance(p.route.distance)
                    : formatDistance(haversineDistance(p.position, midpoint))}
                </div>
                {p.route && (
                  <div className="live-stat-sub">
                    {t(timeKey, {
                      minutes: formatDuration(p.route.duration),
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="live-nav-buttons">
        <a
          href={wazeLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
        >
          {t("live.navigateWaze")}
        </a>
        <a
          href={googleMapsLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
        >
          {t("live.navigateGoogle")}
        </a>
      </div>

      {canInvite && (
        <div className="live-share-row">
          <div className="live-share-label">{t("live.inviteMore")}</div>
          <div className="live-share-actions">
            {canNativeShare ? (
              <button
                type="button"
                className="live-btn live-btn--share"
                onClick={handleNativeShare}
              >
                {t("live.share")}
              </button>
            ) : (
              <>
                <a
                  href={whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="live-btn live-btn--whatsapp"
                >
                  {t("live.shareWhatsApp")}
                </a>
                <button
                  type="button"
                  className="live-btn live-btn--copy"
                  onClick={handleCopy}
                >
                  {copied ? t("live.linkCopied") : t("live.copyLink")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
