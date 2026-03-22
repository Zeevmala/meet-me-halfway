import "./lib/appcheck-debug"; // Must be first — sets debug flag before firebase/app-check loads
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
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
