import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
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
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          padding: "2rem",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "#fef2f2",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1
          style={{
            fontSize: "1.25rem",
            fontWeight: 700,
            color: "#1e293b",
            margin: "0 0 8px",
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            fontSize: "0.875rem",
            color: "#64748b",
            margin: "0 0 24px",
            maxWidth: 320,
          }}
        >
          The app ran into an unexpected error. Please reload to try again.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "10px 24px",
            fontSize: "0.875rem",
            fontWeight: 600,
            color: "#2563eb",
            background: "#eff6ff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
        {import.meta.env.DEV && this.state.error && (
          <pre
            style={{
              marginTop: 24,
              padding: 16,
              background: "#f8fafc",
              borderRadius: 8,
              fontSize: "0.75rem",
              color: "#64748b",
              maxWidth: "90vw",
              overflow: "auto",
              textAlign: "start",
            }}
          >
            {this.state.error.message}
          </pre>
        )}
      </div>
    );
  }
}
