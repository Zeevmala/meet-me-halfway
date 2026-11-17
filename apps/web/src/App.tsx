import { lazy, Suspense, useEffect, useState } from "react";
import StartScreen from "./features/live-midpoint/components/StartScreen";
import SessionErrorPanel from "./features/live-midpoint/components/SessionErrorPanel";
import {
  hasConsent,
  rememberConsent,
} from "./features/live-midpoint/lib/consent";
import { saveDisplayName } from "./features/live-midpoint/lib/display-name";
import {
  codeFromQuery,
  isValidCode,
} from "./features/live-midpoint/lib/session-code";
import { pendingWhileReloading } from "./lib/stale-chunk-reload";
import { t } from "./strings";

// The page is the heavy chunk: the map is most of it. Named, so that it can
// be fetched while the start screen is still being read.
const loadPage = pendingWhileReloading(
  () => import("./features/live-midpoint/LiveMidpointPage"),
);
const LiveMidpointPage = lazy(loadPage);

/**
 * What comes before the session: the link's code, and the person's say-so.
 *
 * Nothing below this is mounted until they have agreed, and everything that
 * touches them is below it — the sign-in, the location request, the session
 * handshake. So a visit that goes no further than this screen signs in to
 * nothing, asks for nothing and writes nothing, whoever or whatever made it.
 */
export default function App() {
  // Read once. A live session writes its code to the URL, so reading it
  // again would turn a creator's re-render into a join of its own session.
  const [urlCode] = useState(() => codeFromQuery(window.location.search));
  // A code the generator could not have produced names no session: there is
  // nothing to agree to, and nothing to ask a location for.
  const invalid = urlCode !== null && !isValidCode(urlCode);
  const [agreed, setAgreed] = useState(() => !invalid && hasConsent(urlCode));
  // The name typed on the start screen, "" if none. Handed to the page as
  // well as saved: a browser that stores nothing would have lost it by the
  // time the session asked.
  const [name, setName] = useState("");

  useEffect(() => {
    if (invalid) return;
    // After the first paint, so the start screen is not kept waiting for it.
    // A failure here is the lazy import's to report when it is needed.
    loadPage().catch(() => {});
  }, [invalid]);

  if (invalid) {
    return <SessionErrorPanel errorCode="INVALID_CODE" errorDetails={null} />;
  }

  if (!agreed) {
    return (
      <StartScreen
        joining={urlCode !== null}
        onStart={(typed) => {
          // Only a name they typed: saving "" would store the device label
          // as if it had been chosen.
          if (typed !== "") saveDisplayName(typed);
          setName(typed);
          rememberConsent(urlCode);
          setAgreed(true);
        }}
      />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="live-page">
          <div className="live-status">{t("app.loading")}</div>
        </div>
      }
    >
      <LiveMidpointPage urlCode={urlCode} initialName={name} />
    </Suspense>
  );
}
