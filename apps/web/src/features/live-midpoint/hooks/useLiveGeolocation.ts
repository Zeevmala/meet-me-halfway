import { useCallback, useEffect, useRef, useState } from "react";

export type GeoStatus =
  | "idle"
  | "requesting"
  | "watching"
  | "denied"
  | "error"
  | "unavailable";

export interface LiveGeoState {
  status: GeoStatus;
  position: { lat: number; lng: number } | null;
  accuracy: number | null;
  error: string | null;
  start: () => void;
  stop: () => void;
}

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 3_000,
};

/**
 * Continuous geolocation streaming via `watchPosition`.
 * Keeps streaming until explicitly stopped or the component unmounts.
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

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus("idle");
  }, []);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      setError("Geolocation is not supported by this browser.");
      return;
    }

    // Clear previous watch if any
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }

    setStatus("requesting");
    setError(null);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus("watching");
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setAccuracy(pos.coords.accuracy);
        setError(null);
      },
      (err) => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setStatus("denied");
            setError("Location access denied.");
            break;
          case err.POSITION_UNAVAILABLE:
            setStatus("unavailable");
            setError("Location not available.");
            break;
          case err.TIMEOUT:
            setStatus("error");
            setError("Location request timed out.");
            break;
          default:
            setStatus("error");
            setError(err.message);
        }
      },
      GEO_OPTIONS,
    );
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  return { status, position, accuracy, error, start, stop };
}
