import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { validateEnv } from "./lib/env";
import ErrorBoundary from "./components/ErrorBoundary";
import App from "./App";

// Validate env vars before anything renders
validateEnv();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
