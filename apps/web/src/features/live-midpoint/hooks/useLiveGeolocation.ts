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

/** Watch restart backoff after POSITION_UNAVAILABLE: 2s → 30s. */
const RETRY_BACKOFF = { baseMs: 2_000, maxMs: 30_000, jitter: true } as const;

/**
 * Restart delay for a restarted watch's opening code 2, which on Chrome 150+
 * is a replay of the error that caused the restart: long enough for a slow
 * fresh request to answer, short enough that a browser without the replay —
 * where that error is the fresh request's real failure — still retries.
 */
const REPLAY_FUSE = { baseMs: 30_000, maxMs: 120_000 } as const;

/**
 * Continuous geolocation streaming via `watchPosition`.
 * Keeps streaming until explicitly stopped or the component unmounts.
 *
 * The three error codes mean different things, and Chrome on Android (read
 * from Chromium's source) draws the lines sharply:
 *
 * - PERMISSION_DENIED: the site is blocked, *or* the phone's Location toggle
 *   is off, *or* Chrome lacks the Android permission. Fatal: Blink drops every
 *   watch. Only a new request made inside a tap can recover, because that is
 *   the only time Chrome will offer its "turn on location" dialog — so the
 *   page puts a Try again button on that screen.
 * - TIMEOUT: no fix yet. The watch stays registered and keeps acquiring, so it
 *   is left alone; tearing it down would throw that progress away.
 * - POSITION_UNAVAILABLE: the platform request itself failed (Play services
 *   rejected it, or an OS permission layer threw). Chrome never re-issues that
 *   request while the watch lives, so the watch is restarted with backoff:
 *   clearing it drops Chrome's last subscriber and the new one makes a fresh
 *   request.
 *
 * The page used to treat POSITION_UNAVAILABLE as final: the whole app became
 * "Location services unavailable", with no retry, no explanation and no
 * telemetry. Once a fix has been seen, a non-fatal error does not change the
 * status and the last position stands. (Presence keeps re-publishing that
 * position with a fresh timestamp, so peers see it as live, not stale.)
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
  const longFuseRef = useRef(false);
  const failuresRef = useRef(0);
  const hasFixRef = useRef(false);
  const sawUnavailableRef = useRef(false);
  const reportedRef = useRef(new Set<number>());

  /** Cancel both the active watch and any pending restart. Idempotent. */
  const teardown = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    longFuseRef.current = false;
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
    sawUnavailableRef.current = false;
    // Try again must start clean. Left set, a fix from before a denial kept
    // every later error from reaching the screen: status sat on "requesting"
    // over the old position, with no message and no button.
    hasFixRef.current = false;
    setStatus("requesting");
    setError(null);

    const watch = (restarted: boolean) => {
      // Chrome 150+ on Android hands a new watch the provider's cached error
      // before any fresh result, so a restarted watch opens with a replay of
      // the code 2 that caused the restart. Restarting on that replay at the
      // normal backoff tore down every replacement before its fresh request
      // could answer. So the opening code 2 of a restarted watch only arms a
      // long fuse (REPLAY_FUSE); a fix cancels it, and a second code 2 — the
      // fresh request failing — swaps it for the normal backoff. Where there
      // is no replay (older Chromium, WebKit) the opening code 2 is real, and
      // the fuse still retries it.
      let replayExpected = restarted;
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          replayExpected = false;
          // A fix means this watch works; a restart still pending from an
          // earlier error would only tear it down and restart the provider.
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          longFuseRef.current = false;
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

          const timedOut = err.code === err.TIMEOUT;
          if (!timedOut) sawUnavailableRef.current = true;

          // Before the first fix, say what failed — but a TIMEOUT never
          // replaces an earlier POSITION_UNAVAILABLE. Restarted watches time
          // out too, and the screen would otherwise flip between two titles,
          // hiding the message that names the actual failure.
          if (!hasFixRef.current && !(timedOut && sawUnavailableRef.current)) {
            setStatus(timedOut ? "error" : "unavailable");
            setError(describeGeoError(err));
          }

          // The timed-out watch is still acquiring; leave it be.
          if (timedOut) return;

          const long = replayExpected;
          replayExpected = false;
          if (retryTimerRef.current !== null) {
            // One restart pending at a time, however many errors arrive —
            // unless a fresh failure lands on a fuse armed for a replay.
            if (!longFuseRef.current) return;
            clearTimeout(retryTimerRef.current);
          }
          // The long fuse waits for an answer; it is not a failure, so it does
          // not advance the backoff.
          const delay = long
            ? backoffDelayMs(failuresRef.current, REPLAY_FUSE)
            : backoffDelayMs(failuresRef.current++, RETRY_BACKOFF);
          longFuseRef.current = long;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            longFuseRef.current = false;
            if (watchIdRef.current !== null) {
              navigator.geolocation.clearWatch(watchIdRef.current);
              watchIdRef.current = null;
            }
            watch(true);
          }, delay);
        },
        GEO_OPTIONS,
      );
    };

    watch(false);
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
 * The code's name, plus the browser's message when it gave one. On Android,
 * Chrome's POSITION_UNAVAILABLE carries the platform's reason ("Failed to
 * request location updates: …"), which is what tells the failures apart; other
 * paths, DevTools' emulated outage among them, send an empty message, and the
 * name keeps the details panel from going blank then.
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
        // Tagged, not just attached: the message is what separates a Play
        // services failure from an OS permission block, and Sentry can only
        // group and search on tags. Tag values are capped at 200 characters.
        geo_msg: err.message.slice(0, 200) || "(empty)",
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
