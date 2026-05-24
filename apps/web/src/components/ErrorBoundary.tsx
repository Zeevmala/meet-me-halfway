import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as Sentry from "@sentry/react";
import "../features/live-midpoint/styles/live-midpoint.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ error }: { error: Error | null }) {
  const { t } = useTranslation();

  return (
    <div className="live-page">
      <div className="live-error">
        <div className="live-error-icon">&#9888;</div>
        <div className="live-error-title">{t("app.errorTitle")}</div>
        <div className="live-error-message">{t("app.errorMessage")}</div>
        <button
          type="button"
          className="live-btn live-retry-btn"
          onClick={() => window.location.reload()}
        >
          {t("app.reload")}
        </button>
        {import.meta.env.DEV && error && (
          <pre
            style={{
              marginTop: 24,
              padding: 16,
              background: "var(--live-glass)",
              color: "var(--live-text-muted)",
              borderRadius: 8,
              fontSize: 12,
              maxWidth: "90vw",
              overflow: "auto",
              textAlign: "start",
              fontFamily: "var(--live-mono)",
            }}
          >
            {error.message}
          </pre>
        )}
      </div>
    </div>
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error("[ErrorBoundary]", error, info.componentStack);
    }
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
    });
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <ErrorFallback error={this.state.error} />;
  }
}
