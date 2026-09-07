/**
 * Transport failure taxonomy shared by every effectful node.
 *
 * Deliberately closed: `Record<ResourceError["kind"], …>` lookups elsewhere
 * become exhaustive at compile time, the way `SESSION_ERROR_I18N` already
 * works in SessionErrorPanel.
 */

export type ResourceError =
  /** HTTP 429. `retryAfterMs` is the server hint, or 0 when absent. */
  | { readonly kind: "RATE_LIMITED"; readonly retryAfterMs: number }
  /** Any other non-2xx response. */
  | { readonly kind: "HTTP"; readonly status: number }
  /** Transport failed outright — DNS, TLS, offline, CORS. */
  | { readonly kind: "NETWORK"; readonly detail: string }
  /** The node's own deadline elapsed before the request settled. */
  | { readonly kind: "TIMEOUT"; readonly afterMs: number }
  /** The circuit breaker refused the call; no request was made. */
  | { readonly kind: "OPEN_CIRCUIT"; readonly retryAtMs: number };

export type ResourceErrorKind = ResourceError["kind"];

/**
 * Whether re-issuing the same request could plausibly succeed.
 *
 * `OPEN_CIRCUIT` is not retryable *by the retry loop* — the breaker already
 * decided to stand down, and retrying would defeat it. The breaker's own
 * half-open probe is what recovers.
 */
export function isRetryableError(error: ResourceError): boolean {
  switch (error.kind) {
    case "RATE_LIMITED":
    case "NETWORK":
    case "TIMEOUT":
      return true;
    case "HTTP":
      // 5xx is worth another attempt; 4xx means the request itself is wrong.
      return error.status >= 500;
    case "OPEN_CIRCUIT":
      return false;
  }
}

/**
 * Whether a failure should count against the circuit breaker.
 *
 * A 4xx that is not 429 says the request is malformed, not that the
 * dependency is unhealthy — counting it would open the breaker on a bug and
 * suppress every subsequent call.
 */
export function countsAgainstBreaker(error: ResourceError): boolean {
  switch (error.kind) {
    case "RATE_LIMITED":
    case "NETWORK":
    case "TIMEOUT":
      return true;
    case "HTTP":
      return error.status >= 500;
    case "OPEN_CIRCUIT":
      return false;
  }
}

/** Stable, log-friendly description. Never interpolated into the UI. */
export function describeResourceError(error: ResourceError): string {
  switch (error.kind) {
    case "RATE_LIMITED":
      return `rate limited (retry after ${error.retryAfterMs}ms)`;
    case "HTTP":
      return `http ${error.status}`;
    case "NETWORK":
      return `network: ${error.detail}`;
    case "TIMEOUT":
      return `timeout after ${error.afterMs}ms`;
    case "OPEN_CIRCUIT":
      return `circuit open until ${error.retryAtMs}`;
  }
}

/** Classify a thrown value from `fetch` into the taxonomy. */
export function classifyThrown(thrown: unknown): ResourceError {
  const detail =
    thrown instanceof Error ? thrown.message : String(thrown ?? "unknown");
  return { kind: "NETWORK", detail };
}

/** Classify a non-OK `Response`. */
export function classifyResponse(res: {
  status: number;
  headers?: { get(name: string): string | null };
}): ResourceError {
  if (res.status === 429) {
    const raw = res.headers?.get("Retry-After");
    const seconds = raw === null || raw === undefined ? NaN : Number(raw);
    return {
      kind: "RATE_LIMITED",
      retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
    };
  }
  return { kind: "HTTP", status: res.status };
}
