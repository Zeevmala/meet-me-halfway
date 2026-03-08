import { useEffect, useRef, useState } from "react";
import type { MidpointResponse, SessionResponse } from "@shared/types";
import { getMidpoint, getSession } from "../lib/api";
import type { AxiosError } from "axios";

interface SessionState {
  session: SessionResponse | null;
  midpoint: MidpointResponse | null;
  loading: boolean;
  error: string | null;
}

export function useSession(sessionId: string | null): SessionState {
  const [state, setState] = useState<SessionState>({
    session: null,
    midpoint: null,
    loading: false,
    error: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    setState({ session: null, midpoint: null, loading: true, error: null });

    getSession(sessionId)
      .then((session) => {
        setState((prev) => ({ ...prev, session, loading: false, error: null }));

        intervalRef.current = setInterval(() => {
          getMidpoint(sessionId)
            .then((midpoint) => setState((prev) => ({ ...prev, midpoint })))
            .catch((err: AxiosError) => {
              if (err.response?.status === 422) return;
              setState((prev) => ({ ...prev, error: err.message }));
            });
        }, 5000);
      })
      .catch((err: Error) =>
        setState({ session: null, midpoint: null, loading: false, error: err.message })
      );

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [sessionId]);

  return state;
}
