import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionErrorCode } from "../hooks/useLiveSession";
import type { AuthErrorCode } from "../../../hooks/useAuth";
import {
  detectInAppBrowser,
  buildOpenInBrowserLink,
} from "../lib/in-app-browser";

/** Map session error codes to i18n keys. */
const SESSION_ERROR_I18N: Record<SessionErrorCode, string> = {
  SESSION_NOT_FOUND: "live.sessionNotFound",
  SESSION_FULL: "live.sessionFull",
  SESSION_EXPIRED: "live.sessionExpired",
  CREATE_FAILED: "live.sessionCreateFailed",
  JOIN_FAILED: "live.sessionJoinFailed",
  JOIN_PERMISSION_DENIED: "live.sessionJoinPermission",
  JOIN_NETWORK_ERROR: "live.sessionJoinNetwork",
  CONNECTION_ERROR: "live.connectionError",
};

/** Errors surfaced by the auth gate, before a session exists. */
const AUTH_ERROR_I18N: Record<AuthErrorCode, string> = {
  AUTH_NETWORK: "live.authNetwork",
  AUTH_STORAGE_BLOCKED: "live.authStorageBlocked",
  AUTH_FAILED: "live.authFailed",
};

/** Every error code this panel can render. */
export type LiveErrorCode = SessionErrorCode | AuthErrorCode;

const PANEL_ERROR_I18N: Record<LiveErrorCode, string> = {
  ...SESSION_ERROR_I18N,
  ...AUTH_ERROR_I18N,
};

/** Errors recoverable by reloading the page (a reload re-runs sign-in and
 * the session join). */
const RETRYABLE_ERRORS: ReadonlySet<LiveErrorCode> = new Set([
  "CREATE_FAILED",
  "JOIN_FAILED",
  "JOIN_PERMISSION_DENIED",
  "JOIN_NETWORK_ERROR",
  "CONNECTION_ERROR",
  "AUTH_NETWORK",
  "AUTH_STORAGE_BLOCKED",
  "AUTH_FAILED",
]);

/** Show the in-app-browser callout for these errors (where switching
 * browsers is likely to actually help — in-app browsers are the canonical
 * cause of blocked storage and failed attestation). */
const IN_APP_BROWSER_HINT_ERRORS: ReadonlySet<LiveErrorCode> = new Set([
  "JOIN_FAILED",
  "JOIN_PERMISSION_DENIED",
  "JOIN_NETWORK_ERROR",
  "CREATE_FAILED",
  "CONNECTION_ERROR",
  "AUTH_NETWORK",
  "AUTH_STORAGE_BLOCKED",
  "AUTH_FAILED",
]);

interface Props {
  errorCode: LiveErrorCode;
  errorDetails: string | null;
}

export default function SessionErrorPanel({ errorCode, errorDetails }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const inApp = detectInAppBrowser();
  const showInAppHint =
    inApp !== null && IN_APP_BROWSER_HINT_ERRORS.has(errorCode);
  const retryable = RETRYABLE_ERRORS.has(errorCode);
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("live.copyLink"), shareUrl);
    }
  }, [shareUrl, t]);

  const handleOpenInBrowser = useCallback(() => {
    const link = buildOpenInBrowserLink(shareUrl);
    if (link === shareUrl) {
      window.open(shareUrl, "_blank", "noopener,noreferrer");
    } else {
      // Use location.href so the OS picks up the scheme (x-safari-https / intent://).
      window.location.href = link;
    }
  }, [shareUrl]);

  return (
    <div className="live-page">
      <div className="live-error">
        <div className="live-error-icon" aria-hidden="true">
          &#9888;
        </div>
        <div className="live-error-title">{t(PANEL_ERROR_I18N[errorCode])}</div>

        {showInAppHint && (
          <div className="live-error-callout">
            <div className="live-error-callout-text">
              {t("live.inAppBrowserDetected")}
            </div>
            <div className="live-error-callout-buttons">
              <button
                type="button"
                className="live-btn live-btn-primary"
                onClick={handleOpenInBrowser}
              >
                {t("live.openInBrowser")}
              </button>
              <button
                type="button"
                className="live-btn live-btn-secondary"
                onClick={handleCopy}
              >
                {copied ? t("live.linkCopied") : t("live.copyLink")}
              </button>
            </div>
          </div>
        )}

        {retryable && (
          <button
            type="button"
            className="live-btn live-retry-btn"
            onClick={() => window.location.reload()}
          >
            {t("common.retry")}
          </button>
        )}

        {errorDetails && (
          <details className="live-error-details">
            <summary>{t("live.errorDetails")}</summary>
            <code>{errorDetails}</code>
          </details>
        )}
      </div>
    </div>
  );
}
