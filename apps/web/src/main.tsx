import "./lib/sentry"; // Must be first — captures errors from all subsequent imports
import "./lib/appcheck-debug"; // Sets debug flag before firebase/app-check loads
import "./lib/register-sw"; // Registers the PWA SW in prod, tears it down in dev
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { APP_CONFIG, validateAppConfig } from "./lib/config";
import { createServices } from "./lib/services";
import { ServicesProvider } from "./components/ServicesProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import App from "./App";
import { reloadOnStaleChunk } from "./lib/stale-chunk-reload";

// Before the first lazy import (App's page chunk), itself the likeliest to
// miss.
reloadOnStaleChunk(window);

// Fail before anything renders if the deployment is misconfigured.
validateAppConfig(APP_CONFIG);

// The composition root. Everything below receives its dependencies from here;
// nothing below constructs a Firebase handle or reads a credential itself.
const services = createServices(APP_CONFIG);

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ServicesProvider services={services}>
        <App />
      </ServicesProvider>
    </ErrorBoundary>
  </StrictMode>,
);
