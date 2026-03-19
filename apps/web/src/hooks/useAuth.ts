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

    // Trigger anonymous sign-in
    signInAnonymously(auth).catch((err: Error) => {
      setState({ status: "error", error: err.message });
    });

    return unsub;
  }, [app]);

  return state;
}
