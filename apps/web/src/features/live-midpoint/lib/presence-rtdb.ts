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
import {
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
} from "firebase/database";
import type { Database } from "firebase/database";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { ParticipantIndex } from "./participant-config";

/** How RTDB words a rules denial in a rejected write. */
const PERMISSION_DENIED = /permission[_ ]denied/i;

/**
 * What a participant publishes. The write's time (`ts`) is not part of it: the
 * writer stamps it with the server's clock. Device clocks disagree — by minutes
 * on some phones — and every peer judges staleness from this one number.
 */
export interface PresenceValue {
  /** Validated against `auth.uid` by the rules; identifies self to peers. */
  readonly uid: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracy: number;
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
  // Paths this client has published and not removed, each with a server-side
  // removal armed for when this client's socket drops — tab close, crash,
  // network loss, none of which reliably fire beforeunload on mobile. Without
  // it a departed participant lingers, keeps dragging the computed midpoint,
  // and leaves their last position in the database for good.
  //
  // Only `participants/{slot}` is cleared, never the `slots/{i}` claim: the
  // claim is write-once, so releasing it would both break that rule's
  // guarantee and let a reconnecting participant come back a different colour.
  const published = new Set<string>();

  const arm = (path: string) => {
    onDisconnect(ref(db, path))
      .remove()
      .catch(() => {
        published.delete(path); // allow a retry on the next write
      });
  };

  // An onDisconnect belongs to the connection that registered it: the server
  // runs it when that connection drops, then forgets it. Arming once per
  // session therefore covered only the first drop — after a reconnect the next
  // one left the participant's position behind. So every new connection
  // re-arms every published path.
  //
  // Subscribed from the first write, not here: this writer is built at the
  // composition root, and a listener at construction would open the socket
  // before App Check has a token (see `appCheckReady`).
  let watching = false;
  let connected: boolean | null = null;
  const watchConnection = () => {
    if (watching) return;
    watching = true;
    onValue(ref(db, ".info/connected"), (snapshot) => {
      const now = snapshot.val() === true;
      // The first value is the connection the write just armed; only a later
      // reconnect needs arming again.
      if (now && connected === false) published.forEach(arm);
      connected = now;
    });
  };

  return {
    write: async (code, slot, value, signal) => {
      const path = presencePath(code, slot);
      const ownRef = ref(db, path);

      if (!published.has(path)) {
        published.add(path);
        arm(path);
      }
      watchConnection();

      try {
        await set(ownRef, { ...value, ts: serverTimestamp() });
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
        // A rules denial — say, once the session is past its 24 hours — was
        // classified as a network failure: retried three times per write,
        // and counted towards opening the breaker on a healthy database.
        const failure = classifyThrown(thrown);
        return err(
          failure.kind === "NETWORK" && PERMISSION_DENIED.test(failure.detail)
            ? { kind: "DENIED", detail: failure.detail }
            : failure,
        );
      }
    },

    remove: (code, slot) => {
      const path = presencePath(code, slot);
      published.delete(path);
      // RTDB sends this over the open WebSocket immediately; it completes even
      // while the page is unloading.
      remove(ref(db, path)).catch(() => {
        /* best effort on unload — onDisconnect is the backstop */
      });
    },
  };
}
