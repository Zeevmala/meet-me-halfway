import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MidpointResponse,
  SessionResponse,
} from "../../../../packages/shared/types";
import { getMidpoint, getSession } from "../lib/api";
import type { AxiosError } from "axios";

interface SessionState {
  session: SessionResponse | null;
  midpoint: MidpointResponse | null;
  loading: boolean;
  error: string | null;
}

// Jittered interval: random 4-6s instead of fixed 5s
function jitteredDelay(): number {
  return 4000 + Math.random() * 2000;
}

// Exponential backoff: 1s, 2s, 4s
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 4000);
}

const MAX_RETRIES = 3;

export function useSession(sessionId: string | null): SessionState {
  const [state, setState] = useState<SessionState>({
    session: null,
    midpoint: null,
    loading: false,
    error: null,
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const stoppedRef = useRef(false);

  const clearPolling = useCallback(() => {
    stoppedRef.current = true;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    stoppedRef.current = false;
    retriesRef.current = 0;
    setState({ session: null, midpoint: null, loading: true, error: null });

    const schedulePoll = () => {
      if (stoppedRef.current) return;
      timeoutRef.current = setTimeout(fetchMidpoint, jitteredDelay());
    };

    const fetchMidpoint = () => {
      if (stoppedRef.current) return;

      getMidpoint(sessionId)
        .then((midpoint) => {
          retriesRef.current = 0;
          setState((prev) => ({ ...prev, midpoint, error: null }));
          schedulePoll();
        })
        .catch((err: AxiosError) => {
          if (stoppedRef.current) return;

          // 422 = not enough participants yet — suppress and keep polling
          if (err.response?.status === 422) {
            schedulePoll();
            return;
          }

          // 410 Gone = session expired — stop polling
          if (err.response?.status === 410) {
            setState((prev) => ({
              ...prev,
              session: prev.session
                ? { ...prev.session, status: "expired" }
                : null,
              error: null,
            }));
            clearPolling();
            return;
          }

          // Network error — retry with exponential backoff
          if (!err.response) {
            retriesRef.current += 1;
            if (retriesRef.current <= MAX_RETRIES) {
              timeoutRef.current = setTimeout(
                fetchMidpoint,
                backoffDelay(retriesRef.current - 1),
              );
              return;
            }
          }

          // All retries exhausted or server error
          setState((prev) => ({ ...prev, error: err.message }));
          schedulePoll();
        });
    };

    getSession(sessionId)
      .then((session) => {
        if (stoppedRef.current) return;

        setState((prev) => ({ ...prev, session, loading: false, error: null }));

        // Stop polling for terminal states
        if (session.status === "expired" || session.status === "completed") {
          // Still fetch midpoint once for completed sessions
          if (session.status === "completed") {
            fetchMidpoint();
          }
          return;
        }

        // Fetch midpoint immediately, then poll with jitter
        fetchMidpoint();
      })
      .catch((err: AxiosError) => {
        if (stoppedRef.current) return;

        // 410 Gone for initial session fetch
        if (err.response?.status === 410) {
          setState({
            session: null,
            midpoint: null,
            loading: false,
            error: "expired",
          });
          return;
        }

        setState({
          session: null,
          midpoint: null,
          loading: false,
          error: err.message,
        });
      });

    return clearPolling;
  }, [sessionId, clearPolling]);

  return state;
}
