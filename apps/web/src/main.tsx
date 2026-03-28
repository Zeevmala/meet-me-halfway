import "./lib/sentry"; // Must be first — captures errors from all subsequent imports
import "./lib/appcheck-debug"; // Sets debug flag before firebase/app-check loads
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./lib/i18n"; // Initialize i18next before React renders
import { validateEnv } from "./lib/env";
import ErrorBoundary from "./components/ErrorBoundary";

const LiveMidpointPage = lazy(
  () => import("./features/live-midpoint/LiveMidpointPage"),
);

// Validate env vars before anything renders
validateEnv();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="live-page">
            <div className="live-status">Loading...</div>
          </div>
        }
      >
        <LiveMidpointPage />
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
