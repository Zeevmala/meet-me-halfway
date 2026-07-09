import { useState, useEffect } from "react";
import {
  signInAnonymously,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { useFirebase } from "./useFirebase";

/** Typed auth error codes — avoids fragile string matching in the UI layer. */
export type AuthErrorCode =
  | "AUTH_NETWORK"
  | "AUTH_STORAGE_BLOCKED"
  | "AUTH_FAILED";

export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; uid: string }
  | { status: "error"; code: AuthErrorCode; message: string };

const MAX_AUTH_RETRIES = 3;

// Storage patterns are checked before network ones so an internal error
// that mentions IndexedDB classifies as storage-blocked even when it also
// mentions the network. Kept local — hooks/ must not depend on feature
// modules (the session classifier lives in features/live-midpoint/lib).
const AUTH_STORAGE_PATTERNS: readonly RegExp[] = [
  /web-storage-unsupported/i,
  /operation-not-supported-in-this-environment/i,
  /indexeddb/i,
  /localstorage/i,
  /web[\s_-]?storage/i,
];

const AUTH_NETWORK_PATTERNS: readonly RegExp[] = [
  /network-request-failed/i,
  /failed to fetch/i,
  /\btimeout\b/i,
  /\bnetwork\b/i,
  /\boffline\b/i,
];

/** Best-effort "code: message" description of a Firebase auth error. */
function describeAuthError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0
      ? `${code}: ${err.message}`
      : err.message;
  }
  return String(err);
}

function classifyAuthError(err: unknown): AuthErrorCode {
  const text = describeAuthError(err);
  if (AUTH_STORAGE_PATTERNS.some((p) => p.test(text))) {
    return "AUTH_STORAGE_BLOCKED";
  }
  if (AUTH_NETWORK_PATTERNS.some((p) => p.test(text))) {
    return "AUTH_NETWORK";
  }
  return "AUTH_FAILED";
}

export function useAuth(): AuthState {
  const { auth } = useFirebase();
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      (user: User | null) => {
        if (user) {
          setState({ status: "authenticated", uid: user.uid });
        }
      },
      (err) => {
        setState({
          status: "error",
          code: classifyAuthError(err),
          message: describeAuthError(err),
        });
      },
    );

    // Trigger anonymous sign-in with retry (exponential backoff: 1s, 2s).
    // Storage-blocked failures are terminal — retrying cannot heal them.
    let attempt = 0;
    const trySignIn = () => {
      signInAnonymously(auth).catch((err: unknown) => {
        attempt++;
        const code = classifyAuthError(err);
        if (code !== "AUTH_STORAGE_BLOCKED" && attempt < MAX_AUTH_RETRIES) {
          setTimeout(trySignIn, 1000 * Math.pow(2, attempt - 1));
        } else {
          setState({
            status: "error",
            code,
            message: describeAuthError(err),
          });
        }
      });
    };
    trySignIn();

    return unsub;
  }, [auth]);

  return state;
}
