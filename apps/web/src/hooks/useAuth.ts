import { useState, useEffect } from "react";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { useFirebase } from "./useFirebase";

export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; uid: string }
  | { status: "error"; error: string };

const MAX_AUTH_RETRIES = 3;

export function useAuth(): AuthState {
  const { app } = useFirebase();
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    const auth = getAuth(app);

    const unsub = onAuthStateChanged(
      auth,
      (user: User | null) => {
        if (user) {
          setState({ status: "authenticated", uid: user.uid });
        }
      },
      (err) => {
        setState({ status: "error", error: err.message });
      },
    );

    // Trigger anonymous sign-in with retry (exponential backoff: 1s, 2s, 4s)
    let attempt = 0;
    const trySignIn = () => {
      signInAnonymously(auth).catch((err: Error) => {
        attempt++;
        if (attempt < MAX_AUTH_RETRIES) {
          setTimeout(trySignIn, 1000 * Math.pow(2, attempt - 1));
        } else {
          setState({ status: "error", error: err.message });
        }
      });
    };
    trySignIn();

    return unsub;
  }, [app]);

  return state;
}
