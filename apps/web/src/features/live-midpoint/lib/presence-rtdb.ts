/**
 * The RTDB side of the presence write, behind the graph's port interface.
 *
 * Participants are keyed by **slot**, not by uid. The slot is claimed under
 * `sessions/{code}/slots/{i}` with a write-once rule, so the database — not a
 * client-side `if` — decides who holds it, and the security rule for this path
 * is simply "you may write `participants/{i}` iff `slots/{i}` is your uid".
 * The uid still travels inside the payload: peers need it to tell themselves
 * apart from everyone else, and the rules validate it against `auth.uid`.
 */
import { onDisconnect, ref, remove, set } from "firebase/database";
import type { Database } from "firebase/database";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { ParticipantIndex } from "./participant-config";

export interface PresenceValue {
  /** Validated against `auth.uid` by the rules; identifies self to peers. */
  readonly uid: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracy: number;
  readonly ts: number;
  readonly name: string;
}

export interface PresenceWriter {
  readonly write: (
    code: string,
    slot: ParticipantIndex,
    value: PresenceValue,
    signal: AbortSignal,
  ) => Promise<Result<void, ResourceError>>;
  readonly remove: (code: string, slot: ParticipantIndex) => void;
}

export function presencePath(code: string, slot: ParticipantIndex): string {
  return `sessions/${code}/participants/${slot}`;
}

export function createPresenceWriter(db: Database): PresenceWriter {
  // Arm the server-side cleanup once per session rather than on every write.
  // Keyed by path so a rejoin under a different code re-arms.
  const armed = new Set<string>();

  return {
    write: async (code, slot, value, signal) => {
      const path = presencePath(code, slot);
      const ownRef = ref(db, path);

      // When this client's socket drops — tab close, crash, network loss, none
      // of which reliably fire beforeunload on mobile — Firebase clears our
      // participant node. Without it a departed participant lingers and keeps
      // dragging the computed midpoint.
      //
      // Only `participants/{slot}` is cleared, never the `slots/{i}` claim:
      // the claim is write-once, so releasing it would both break that rule's
      // guarantee and let a reconnecting participant come back a different
      // colour.
      if (!armed.has(path)) {
        armed.add(path);
        onDisconnect(ownRef)
          .remove()
          .catch(() => {
            armed.delete(path); // allow a retry on the next write
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

    remove: (code, slot) => {
      const path = presencePath(code, slot);
      armed.delete(path);
      // RTDB sends this over the open WebSocket immediately; it completes even
      // while the page is unloading.
      remove(ref(db, path)).catch(() => {
        /* best effort on unload — onDisconnect is the backstop */
      });
    },
  };
}
