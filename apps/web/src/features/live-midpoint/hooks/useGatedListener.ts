import { useEffect, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import type { Database } from "firebase/database";

/** The first pause before attaching again; it doubles up to the next. */
export const RELISTEN_BASE_MS = 1_000;
/** The longest pause between attempts. */
export const RELISTEN_MAX_MS = 15_000;
/**
 * How long refusals go on before they are not a reconnect being ridden out:
 * well past the ten seconds in which the presence heartbeat writes own
 * position again.
 */
export const PERSISTENT_MS = 30_000;

/** How a run of cancellations stands, as the caller is told of each. */
export interface Unanswered {
  /** Cancellations in a row, with no answer between; 1 for the first. */
  readonly attempts: number;
  /** Since the first of them. */
  readonly sinceMs: number;
  /**
   * True once a run: at the first cancellation `PERSISTENT_MS` or more after
   * the run began. What to report, or give up on.
   */
  readonly becamePersistent: boolean;
}

/**
 * A listener at `path`, attached again after the server cancels it, for as
 * long as `path` is not `null`.
 *
 * The rules let a slot holder read the others — positions, trips, copies of
 * the meeting point — only while its own position is published, and RTDB
 * holds an attached listener to that: it cancels the listener of a reader
 * whose position is deleted (`rules/database.rules.test.ts`). A reader that
 * is still sharing is cancelled too, after a reconnect: the server deleted
 * its position when the connection dropped (onDisconnect), and the SDK
 * restores its listens before its writes, so the read is refused until the
 * presence heartbeat writes the position again. A listener given up at the
 * first cancellation stayed dead for the rest of the page's life.
 *
 * So a cancellation is answered by attaching again, after a pause that grows
 * — 1 s, 2 s, 4 s, 8 s, then every 15 s — until one answers or `path` goes
 * `null`. `onCancel` hears every cancellation and returns `false` to stop.
 */
export function useGatedListener(
  db: Database,
  path: string | null,
  onSnapshot: (value: unknown) => void,
  onCancel: (error: Error, unanswered: Unanswered) => boolean,
): void {
  // The latest callbacks, without attaching again whenever they change.
  const snapshotRef = useRef(onSnapshot);
  snapshotRef.current = onSnapshot;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const [generation, setGeneration] = useState(0);
  const failing = useRef<{
    path: string;
    attempts: number;
    since: number;
    persistent: boolean;
  } | null>(null);

  useEffect(() => {
    if (path === null) {
      failing.current = null;
      return;
    }
    if (failing.current !== null && failing.current.path !== path) {
      failing.current = null;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onValue(
      ref(db, path),
      (snap) => {
        failing.current = null;
        snapshotRef.current(snap.val());
      },
      (error) => {
        const now = Date.now();
        const run = failing.current ?? {
          path,
          attempts: 0,
          since: now,
          persistent: false,
        };
        run.attempts += 1;
        const becamePersistent =
          !run.persistent && now - run.since >= PERSISTENT_MS;
        if (becamePersistent) run.persistent = true;
        failing.current = run;
        const retry = cancelRef.current(error, {
          attempts: run.attempts,
          sinceMs: now - run.since,
          becamePersistent,
        });
        if (!retry) return;
        const pauseMs = Math.min(
          RELISTEN_MAX_MS,
          RELISTEN_BASE_MS * 2 ** (run.attempts - 1),
        );
        timer = setTimeout(() => setGeneration((g) => g + 1), pauseMs);
      },
    );
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [db, path, generation]);
}
