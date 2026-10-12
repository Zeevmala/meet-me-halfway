import { useCallback, useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/react";
import { backoffDelayMs } from "../../../core/dag/backoff";

export type GeoStatus =
  "idle" | "requesting" | "watching" | "denied" | "error" | "unavailable";

export interface LiveGeoState {
  status: GeoStatus;
  position: { lat: number; lng: number } | null;
  accuracy: number | null;
  /** What the browser reported for the last failure, for the error details. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 3_000,
};

/** Watch restart backoff after POSITION_UNAVAILABLE / TIMEOUT: 2s → 30s. */
const RETRY_BACKOFF = { baseMs: 2_000, maxMs: 30_000, jitter: true } as const;

/**
 * Continuous geolocation streaming via `watchPosition`.
 * Keeps streaming until explicitly stopped or the component unmounts.
 *
 * Only PERMISSION_DENIED is terminal. POSITION_UNAVAILABLE and TIMEOUT mean
 * the provider had no fix *this time* — a cold GPS, a location service that
 * was still starting, a moment indoors — so the watch is restarted with
 * backoff rather than abandoned. The page used to treat POSITION_UNAVAILABLE
 * as final: the whole app became "Location services unavailable", with no
 * retry, no explanation and no telemetry, and it cleared only if that same
 * watch later got a fix — which on a device whose provider stays down never
 * happens. Once a fix has been seen, a transient error does not change the
 * status at all; the last position stands, and the graph's staleness rules
 * decide what it is worth.
 */
export function useLiveGeolocation(): LiveGeoState {
  const [status, setStatus] = useState<GeoStatus>("idle");
  const [position, setPosition] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const hasFixRef = useRef(false);
  const reportedRef = useRef(new Set<number>());

  /** Cancel both the active watch and any pending restart. Idempotent. */
  const teardown = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    teardown();
    setStatus("idle");
  }, [teardown]);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      setError("Geolocation is not supported by this browser.");
      return;
    }

    teardown();
    failuresRef.current = 0;
    setStatus("requesting");
    setError(null);

    const watch = () => {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          failuresRef.current = 0;
          hasFixRef.current = true;
          setStatus("watching");
          setPosition({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          });
          setAccuracy(pos.coords.accuracy);
          setError(null);
        },
        (err) => {
          reportOnce(reportedRef.current, err, hasFixRef.current);

          if (err.code === err.PERMISSION_DENIED) {
            teardown();
            setStatus("denied");
            setError(describeGeoError(err));
            return;
          }

          if (!hasFixRef.current) {
            setStatus(err.code === err.TIMEOUT ? "error" : "unavailable");
            setError(describeGeoError(err));
          }

          // Chrome keeps a watch alive across this error (checked against
          // CDP's emulated outage), but the spec does not promise it, so the
          // watch is restarted rather than trusted. One restart pending at a
          // time, however many errors arrive.
          if (retryTimerRef.current !== null) return;
          const delay = backoffDelayMs(failuresRef.current, RETRY_BACKOFF);
          failuresRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (watchIdRef.current !== null) {
              navigator.geolocation.clearWatch(watchIdRef.current);
              watchIdRef.current = null;
            }
            watch();
          }, delay);
        },
        GEO_OPTIONS,
      );
    };

    watch();
  }, [teardown]);

  // Cleanup on unmount
  useEffect(() => teardown, [teardown]);

  return { status, position, accuracy, error, start, stop };
}

const GEO_ERROR_NAMES: Record<number, string> = {
  1: "PERMISSION_DENIED",
  2: "POSITION_UNAVAILABLE",
  3: "TIMEOUT",
};

/**
 * The code's name, plus the browser's message when it gave one. Chrome
 * reports POSITION_UNAVAILABLE with an empty message, so the message alone
 * would leave the details panel blank on exactly the failure it is for.
 */
function describeGeoError(err: GeolocationPositionError): string {
  const name = GEO_ERROR_NAMES[err.code] ?? `code ${err.code}`;
  return err.message ? `${name}: ${err.message}` : name;
}

/**
 * Send each distinct error code to Sentry once per mount.
 *
 * Geolocation failures were never reported, so for months the one failure
 * users actually saw was the one telemetry could not: every investigation
 * chased the RTDB and App Check errors that *were* visible. The permission
 * state separates the cases the error code alone cannot — POSITION_UNAVAILABLE
 * with permission "granted" is the device's location provider failing, not
 * the user saying no. Coordinates are never included.
 */
function reportOnce(
  reported: Set<number>,
  err: GeolocationPositionError,
  hadFix: boolean,
): void {
  if (reported.has(err.code)) return;
  reported.add(err.code);
  void permissionState().then((permission) => {
    Sentry.captureMessage("geolocation_error", {
      level: "warning",
      tags: {
        geo_code: String(err.code),
        geo_permission: permission,
        geo_had_fix: String(hadFix),
        secure_context: String(window.isSecureContext),
      },
      extra: { message: err.message },
    });
  });
}

async function permissionState(): Promise<string> {
  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state;
  } catch {
    return "unknown";
  }
}
