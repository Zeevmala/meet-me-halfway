/**
 * The RTDB side of the presence write, behind the graph's port interface.
 *
 * The write itself used to live in `useLiveSession` with a hand-rolled
 * leading/trailing throttle, its own retry helper and no cancellation. All of
 * that is now the `presence` resource's job; what is left here is the part
 * that genuinely knows about Firebase.
 */
import { onDisconnect, ref, remove, set } from "firebase/database";
import type { Database } from "firebase/database";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";

export interface PresenceValue {
  readonly lat: number;
  readonly lng: number;
  readonly accuracy: number;
  readonly ts: number;
  readonly name: string;
}

export interface PresenceWriter {
  readonly write: (
    code: string,
    uid: string,
    value: PresenceValue,
    signal: AbortSignal,
  ) => Promise<Result<void, ResourceError>>;
  readonly remove: (code: string, uid: string) => void;
}

export function createPresenceWriter(db: Database): PresenceWriter {
  // Arm the server-side cleanup once per session rather than on every write.
  // Keyed by path so a rejoin under a different code re-arms.
  const armed = new Set<string>();

  function path(code: string, uid: string): string {
    return `sessions/${code}/participants/${uid}`;
  }

  return {
    write: async (code, uid, value, signal) => {
      const ownRef = ref(db, path(code, uid));

      // When this client's socket drops — tab close, crash, network loss, none
      // of which reliably fire beforeunload on mobile — Firebase removes our
      // participant node. Without it a departed participant lingers and keeps
      // dragging the computed midpoint.
      const key = path(code, uid);
      if (!armed.has(key)) {
        armed.add(key);
        onDisconnect(ownRef)
          .remove()
          .catch(() => {
            armed.delete(key); // allow a retry on the next write
          });
      }

      try {
        await set(ownRef, value);
        // The resource aborts a superseded write, but `set` has already been
        // sent over the WebSocket by then; report the abort so the epoch guard
        // discards the result rather than counting it as a success.
        if (signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return ok(undefined);
      } catch (thrown) {
        if (thrown instanceof DOMException && thrown.name === "AbortError") {
          throw thrown;
        }
        return err(classifyThrown(thrown));
      }
    },

    remove: (code, uid) => {
      armed.delete(path(code, uid));
      // RTDB sends this over the open WebSocket immediately; it completes even
      // while the page is unloading.
      remove(ref(db, path(code, uid))).catch(() => {
        /* best effort on unload — onDisconnect is the backstop */
      });
    },
  };
}
