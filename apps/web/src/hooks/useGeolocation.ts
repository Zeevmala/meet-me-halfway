import { useCallback, useEffect, useRef, useState } from "react";

export type GeolocationStatus =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unavailable"
  | "error";

export interface GeolocationState {
  status: GeolocationStatus;
  position: { lat: number; lng: number } | null;
  accuracy: number | null;
  error: string | null;
  requestLocation: () => void;
}

/**
 * Browser geolocation hook — one-shot getCurrentPosition.
 *
 * States: idle → requesting → granted / denied / error / unavailable.
 * High accuracy, 10s timeout, accepts cached position up to 1 min.
 */
export function useGeolocation(): GeolocationState {
  const [status, setStatus] = useState<GeolocationStatus>("idle");
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      setError("Geolocation is not supported by this browser");
    }
  }, []);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      return;
    }

    setStatus("requesting");
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
        setStatus("granted");
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
          setError("Location permission denied");
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setStatus("error");
          setError("Position unavailable");
        } else {
          setStatus("error");
          setError("Location request timed out");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      },
    );
  }, []);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return { status, position, accuracy, error, requestLocation };
}
