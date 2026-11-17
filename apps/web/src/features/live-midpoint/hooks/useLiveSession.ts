import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  onValue,
  ref,
  set,
  get,
  serverTimestamp,
  update,
} from "firebase/database";
import type { Database } from "firebase/database";
import * as Sentry from "@sentry/react";
import { useFirebase } from "../../../hooks/useFirebase";
import { generateCode, isValidCode } from "../lib/session-code";
import {
  getOrCreateDisplayName,
  sanitizeName,
  saveDisplayName,
} from "../lib/display-name";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { PeerTrip, PinEvent } from "../graph/types";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { backoffDelayMs } from "../../../core/dag/backoff";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import { classifyJoinError, describeError } from "../lib/error-classification";
import { detectInAppBrowser } from "../lib/in-app-browser";
import { useGatedListener } from "./useGatedListener";

/** Typed error codes — avoids fragile string matching in the UI layer. */
export type SessionErrorCode =
  /** The link's code is not one the app could have generated. */
  | "INVALID_CODE"
  | "SESSION_NOT_FOUND"
  | "SESSION_FULL"
  /** The session passed its 24 hours while the page was open. */
  | "SESSION_EXPIRED"
  | "CREATE_FAILED"
  | "JOIN_FAILED"
  | "JOIN_PERMISSION_DENIED"
  | "JOIN_NETWORK_ERROR"
  | "CONNECTION_ERROR";

interface ParticipantData {
  uid: string;
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
  name?: string;
}

/**
 * Info about another participant in the session.
 *
 * No `stale` flag: staleness is `now - lastSeen > threshold`, derived by the
 * graph's `liveness` node. Computing it here meant it could only change when
 * something pushed, which is why it needed a polling interval.
 */
export interface ParticipantInfo {
  uid: string;
  position: LatLng;
  accuracy: number;
  lastSeen: number;
  index: ParticipantIndex;
  name: string | null;
}

/** Why a session handshake failed, and what the raw error said. */
export interface SessionFailure {
  readonly code: SessionErrorCode;
  readonly details: string | null;
}

/**
 * The session as this hook knows it. One union rather than a status beside a
 * nullable code, slot and error, because those disagreed: status `error` with
 * a code and slot still set kept presence publishing behind the error screen,
 * and nothing could say "closed" at all. ARCHITECTURE.md draws the machine.
 *
 * `creating` and `joining` carry the id of the handshake they wait on, so a
 * result from one that was abandoned or replaced is recognised and dropped.
 * The graph's `SessionLifecycle` is this minus those ids and the failure, and
 * this is assignable to it as it is.
 */
export type SessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "creating"; readonly handshake: number }
  | { readonly kind: "joining"; readonly handshake: number }
  | {
      readonly kind: "live";
      readonly code: string;
      readonly slot: ParticipantIndex;
      /** Server-clock ms at which `created` was stamped. */
      readonly createdAtMs: number;
    }
  | {
      /** The server cancelled the participants listener. */
      readonly kind: "lost";
      readonly code: string;
      readonly slot: ParticipantIndex;
      readonly createdAtMs: number;
      readonly details: string | null;
    }
  | {
      readonly kind: "failed";
      readonly reason: SessionErrorCode;
      readonly details: string | null;
    }
  | { readonly kind: "closed" };

export type SessionEvent =
  | {
      readonly type: "started";
      readonly handshake: number;
      readonly role: "create" | "join";
    }
  | {
      readonly type: "succeeded";
      readonly handshake: number;
      readonly code: string;
      readonly slot: ParticipantIndex;
      readonly createdAtMs: number;
    }
  | {
      readonly type: "failed";
      readonly handshake: number;
      readonly failure: SessionFailure;
    }
  /** The handshake's caller went away — an unmount, StrictMode's included. */
  | { readonly type: "abandoned"; readonly handshake: number }
  | {
      readonly type: "listenerCancelled";
      readonly code: string;
      readonly details: string | null;
    }
  /** The page is going away. */
  | { readonly type: "closed" };

export const IDLE_SESSION: SessionState = Object.freeze({ kind: "idle" });

/**
 * The one closed state. A constant, so that the page can push it into the
 * graph synchronously from `pagehide` and the render that follows pushes the
 * very same value — a no-op.
 */
export const CLOSED_SESSION: SessionState = Object.freeze({ kind: "closed" });

/** Whether `state` is waiting on `handshake`. */
function waitsOn(state: SessionState, handshake: number): boolean {
  return (
    (state.kind === "creating" || state.kind === "joining") &&
    state.handshake === handshake
  );
}

/**
 * Every transition the session makes. Anything not listed leaves the state
 * as it is — the same object, so React does not even re-render — which is
 * what drops a late result from a handshake nobody is waiting on.
 */
export function sessionReducer(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  switch (event.type) {
    case "started":
      // A new handshake replaces one still running — StrictMode's remount
      // starts its own before the abandoned one has noticed — and may follow
      // a failed one. Nothing starts over a session that exists or closed.
      if (
        state.kind === "live" ||
        state.kind === "lost" ||
        state.kind === "closed"
      ) {
        return state;
      }
      return event.role === "create"
        ? { kind: "creating", handshake: event.handshake }
        : { kind: "joining", handshake: event.handshake };
    case "succeeded":
      if (!waitsOn(state, event.handshake)) return state;
      return {
        kind: "live",
        code: event.code,
        slot: event.slot,
        createdAtMs: event.createdAtMs,
      };
    case "failed":
      if (!waitsOn(state, event.handshake)) return state;
      return {
        kind: "failed",
        reason: event.failure.code,
        details: event.failure.details,
      };
    case "abandoned":
      return waitsOn(state, event.handshake) ? IDLE_SESSION : state;
    case "listenerCancelled":
      if (state.kind !== "live" || state.code !== event.code) return state;
      return {
        kind: "lost",
        code: state.code,
        slot: state.slot,
        createdAtMs: state.createdAtMs,
        details: event.details,
      };
    case "closed":
      return CLOSED_SESSION;
  }
}

export interface LiveSession {
  /** Where the session is. The graph takes it as it is. */
  readonly state: SessionState;
  readonly ownName: string;
  readonly participants: ParticipantInfo[];
  /**
   * How many of the five slots have ever been claimed, own included: 0 until
   * the live session answers, and whenever no session is live. Not how many
   * people are present — they come and go, and a claim is never released.
   */
  readonly claimedSlots: number;
  /**
   * Whether `participants` is what the database says: the participants
   * listener is attached for the live session and has answered. False while
   * this device is not sharing — it is not listening then — so that "nobody
   * else is here" is never said for "nobody else has been read".
   */
  readonly rosterKnown: boolean;
  /**
   * The copies of the meeting point the database holds
   * (`sessions/{code}/meet`), this device's own included; empty while no
   * session is live or this device is not sharing. Which one stands is the
   * graph's to decide.
   */
  readonly peerPins: readonly PinEvent[];
  /**
   * By slot, the trip each device published (`sessions/{code}/trips`); all
   * `null` while no session is live or this device is not sharing.
   */
  readonly peerTrips: readonly (PeerTrip | null)[];
  /**
   * Both return a Result rather than throwing.
   *
   * They used to throw, and the page called them from an effect with no
   * `.catch()` — so every failed join produced an unhandled rejection and a
   * duplicate Sentry event on top of the one raised deliberately. `Result` is
   * also what the rest of the codebase uses for fallible work.
   *
   * The signal cancels the retry loop: an unmount mid-join previously left a
   * three-attempt backoff running against a dead component.
   */
  readonly createSession: (
    signal: AbortSignal,
  ) => Promise<Result<string, SessionFailure>>;
  readonly joinSession: (
    code: string,
    signal: AbortSignal,
  ) => Promise<Result<string, SessionFailure>>;
  readonly setOwnName: (name: string) => void;
  /**
   * The page is going away. Leaving `live` detaches the listener; own
   * position is the graph's presence node's to remove, which it does as soon
   * as the session it was given is no longer live.
   */
  readonly close: () => void;
}

/**
 * Fresh codes a create tries before giving up. `created` is write-once, so
 * the rules refuse it under a code that is already taken — and since sessions
 * are never deleted, every code ever used stays taken.
 */
const MAX_CODE_ATTEMPTS = 3;

// Retry transient Firebase failures with exponential backoff (1s, 2s)
// before surfacing the error. Most flake on iOS Safari resolves within
// ~3s; this means users rarely see the error screen at all.
async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  attempts = 3,
  isRetryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isRetryable(err)) {
        await sleep(backoffDelayMs(i, { baseMs: 1000 }), signal);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/** Abortable delay, so a teardown does not have to wait out the backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Permission errors won't recover via retry — bail immediately. */
function isTransientError(err: unknown): boolean {
  return classifyJoinError(err) !== "JOIN_PERMISSION_DENIED";
}

/**
 * Build Sentry context for a session-flow failure.
 *
 * `hasAppCheck` now reports whether attestation is actually *running*, not
 * merely whether a site key was configured. The two diverge exactly when it
 * matters — a blocked reCAPTCHA script in an in-app browser leaves the key set
 * and App Check off — which is the case these reports exist to diagnose.
 */
function sessionContext(code: string | null, hasAppCheck: boolean) {
  return {
    session: {
      // Don't ship the full code — keep PII low. The first 2 chars are
      // enough to correlate with our own debug reports.
      codePrefix: code ? code.slice(0, 2) : null,
      online: typeof navigator !== "undefined" ? navigator.onLine : null,
      inAppBrowser: detectInAppBrowser(),
      hasAppCheck,
    },
  };
}

/**
 * Whether this connection may read anything at all — the question a denied
 * session read leaves open.
 *
 * The rules deny reads of a missing or expired session on purpose: it keeps
 * the code space opaque. So that denial normally means exactly "no such
 * session". But the same denial comes back when it is the device being turned
 * away — no auth token on the socket, or App Check enforcement refusing an
 * unattested client — and "Session not found" then sent people off for a new
 * link that would fail the same way, while nothing reached Sentry. `probe`
 * holds nothing and any signed-in client may read it, so it answers for the
 * device and never for a session.
 */
async function canReadAtAll(db: Database): Promise<boolean> {
  try {
    await get(ref(db, "probe"));
    return true;
  } catch {
    return false;
  }
}

/**
 * `created` as the server stamped it.
 *
 * Expiry is judged against the server's clock, so it needs the server's
 * value, and the creator never sees that otherwise: its write sends a
 * placeholder the server fills in. Read back after the write, it costs the
 * creator one round trip before the code appears.
 */
async function readCreated(db: Database, code: string): Promise<number> {
  const created: unknown = (
    await get(ref(db, `sessions/${code}/created`))
  ).val();
  if (typeof created !== "number") {
    throw new Error(`sessions/${code}/created is not a timestamp`);
  }
  return created;
}

/** `sessions/{code}/slots` as RTDB stores it: slot key → holder uid. */
type SlotMap = Partial<Record<string, string>>;

const NO_PINS: readonly PinEvent[] = Object.freeze([]);
const NO_TRIPS: readonly (PeerTrip | null)[] = Object.freeze(
  new Array<PeerTrip | null>(MAX_PARTICIPANTS).fill(null),
);
const NO_PARTICIPANTS: ParticipantInfo[] = [];

function isSlot(value: unknown): value is ParticipantIndex {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_PARTICIPANTS
  );
}

/**
 * `sessions/{code}/meet` as the graph takes it: one pin per entry, sorted by
 * slot. A snapshot is untrusted input to this process — the rules hold every
 * field to its type and range, but a snapshot is not the rules — so an entry
 * that is not a well-formed pin is dropped rather than trusted.
 */
export function parsePins(raw: unknown): readonly PinEvent[] {
  if (raw === null || typeof raw !== "object") return NO_PINS;
  const pins: { slot: number; pin: PinEvent }[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const slot = Number(key);
    if (!isSlot(slot) || value === null || typeof value !== "object") continue;
    const { at, by, byName, lat, lng, name } = value as Record<string, unknown>;
    if (
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      !isSlot(by) ||
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      // A range test alone lets NaN through: every comparison with it is
      // false.
      !(Math.abs(lat) <= 90) ||
      !(Math.abs(lng) <= 180)
    ) {
      continue;
    }
    pins.push({
      slot,
      pin: {
        at,
        by,
        byName: sanitizeName(byName),
        position: { lat, lng },
        name: typeof name === "string" && name.trim() !== "" ? name : null,
      },
    });
  }
  if (pins.length === 0) return NO_PINS;
  return pins.sort((a, b) => a.slot - b.slot).map(({ pin }) => pin);
}

/**
 * `sessions/{code}/trips` as the graph takes it: by slot, `null` where there
 * is none. Untrusted input, like the pins: an entry that is not a well-formed
 * trip is dropped. The line is checked when it is decoded, by the graph.
 */
export function parseTrips(raw: unknown): readonly (PeerTrip | null)[] {
  if (raw === null || typeof raw !== "object") return NO_TRIPS;
  const trips = NO_TRIPS.slice();
  let any = false;
  for (const [key, value] of Object.entries(raw)) {
    const slot = Number(key);
    if (!isSlot(slot) || value === null || typeof value !== "object") continue;
    const { lat, lng, profile, duration, distance, line } = value as Record<
      string,
      unknown
    >;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !(Math.abs(lat) <= 90) ||
      !(Math.abs(lng) <= 180) ||
      (profile !== "driving" && profile !== "walking") ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      distance < 0 ||
      typeof line !== "string"
    ) {
      continue;
    }
    trips[slot] = { dest: { lat, lng }, profile, duration, distance, line };
    any = true;
  }
  return any ? trips : NO_TRIPS;
}

/** The slot `uid` holds in `slots`, if any. */
function heldBy(slots: SlotMap, uid: string): ParticipantIndex | null {
  for (const [key, holder] of Object.entries(slots)) {
    if (holder === uid) return Number(key) as ParticipantIndex;
  }
  return null;
}

/**
 * Claim a slot, letting the database arbitrate.
 *
 * The write-once rule *is* the arbitration: two clients racing for the same
 * index are serialised by the server, and the loser's `set` is rejected with
 * permission_denied. So there is no transaction and no client-side registry —
 * we simply try the free indices in order and re-read on a rejection.
 *
 * Slot 0 is the creator's: the rule additionally requires the value to equal
 * `creatorUid`, which makes "the creator is green" a server invariant rather
 * than a convention every client has to honour.
 *
 * A rejection is only evidence of a lost race if the index is *held* once the
 * dust settles. This used to be assumed rather than checked, and the assumption
 * silently inverted the meaning of the return value: when the deployed rules
 * did not match the deployed client — the 2026-09-11 outage — every `set` was
 * denied structurally, the loop burned its attempts against an index nobody
 * held, and `null` was reported to the user as "session is full" about a
 * session with nobody in it. So we re-read the index we were refused and only
 * treat it as a lost race if somebody is actually in it; anything else is a
 * real error and is rethrown for `withRetry` to classify.
 *
 * The rules also allow an account one slot per session, so a refusal can
 * mean "you already hold one" as well: that slot is returned.
 *
 * @returns the claimed slot, or `null` when all five are genuinely held.
 * @throws if a claim is refused for any reason other than losing the race.
 */
async function claimSlot(
  db: Database,
  sessionCode: string,
  uid: string,
  isCreator: boolean,
): Promise<ParticipantIndex | null> {
  const slotsRef = ref(db, `sessions/${sessionCode}/slots`);
  const candidates: ParticipantIndex[] = isCreator
    ? [0]
    : [1, 2, 3, 4].map((i) => i as ParticipantIndex);

  // At most one attempt per slot: a rejection we accept is one we have proven
  // left the index occupied, so the loop strictly makes progress.
  for (let attempt = 0; attempt < MAX_PARTICIPANTS; attempt++) {
    const snap = await get(slotsRef);
    const slots = (snap.val() ?? {}) as SlotMap;

    // Idempotent rejoin: we may already hold one from a previous mount.
    const mine = heldBy(slots, uid);
    if (mine !== null) return mine;

    const free = candidates.find((slot) => slots[String(slot)] === undefined);
    if (free === undefined) return null;

    const slotRef = ref(db, `sessions/${sessionCode}/slots/${free}`);
    try {
      await set(slotRef, uid);
      return free;
    } catch (refused) {
      // Re-read the one index rather than the whole map: this is the narrowest
      // question we can ask, and it is the question that distinguishes the two
      // causes. A read denial here propagates, which is correct — it means we
      // cannot see the session at all.
      const holder = (await get(slotRef)).val() as string | null;
      if (holder === uid) return free; // write landed, ack lost
      if (holder === null) {
        // Nobody took it, so this was not a race for the index. The rules
        // allow an account one slot per session, though, so there is one
        // refusal that is not an error either: another tab of this browser,
        // signed in as the same account, claimed a different index between
        // our read and our write. That slot is ours.
        const elsewhere = heldBy(
          ((await get(slotsRef)).val() ?? {}) as SlotMap,
          uid,
        );
        if (elsewhere !== null) return elsewhere;
        throw refused;
      }
      // Somebody holds it — a genuine lost race. Try the next free index.
    }
  }
  return null;
}

/**
 * Manages a live session backed by Firebase RTDB.
 *
 * RTDB schema:
 *   sessions/{code}/created        — timestamp
 *   sessions/{code}/creatorUid     — uid of session creator (write-once)
 *   sessions/{code}/slots/{0..4}   — uid (write-once; exactly five keys exist)
 *   sessions/{code}/participants/{slot} — { uid, lat, lng, accuracy, ts, name }
 *
 * The five fixed slot keys are what enforces MAX_PARTICIPANTS. The rules
 * reject any key outside 0..4 and any write to an occupied one, so the cap is
 * a property of the schema rather than a client-side check that a modified
 * client could simply skip.
 *
 * The handshakes only report what happened. What follows from a state — the
 * participants listener, the code in the URL — is an effect of being in it,
 * attached on entering and detached on leaving, so nothing a handshake does
 * can outlive the state it was for.
 *
 * @param uid  Firebase Anonymous Auth uid (from useAuth)
 */
/**
 * @param listen Whether to read the others: true while this device's own
 *   position is published (`GraphSnapshot.sharing`). Whoever does not share
 *   sees nobody, so nobody can watch unseen.
 */
export function useLiveSession(uid: string, listen: boolean): LiveSession {
  const { db, appCheckConfigured, appCheckReady } = useFirebase();

  const [state, dispatch] = useReducer(sessionReducer, IDLE_SESSION);
  const [roster, setRoster] = useState<{
    readonly code: string;
    readonly participants: ParticipantInfo[];
  } | null>(null);
  const [meetPins, setMeetPins] = useState<{
    readonly code: string;
    readonly pins: readonly PinEvent[];
  } | null>(null);
  const [trips, setTrips] = useState<{
    readonly code: string;
    readonly trips: readonly (PeerTrip | null)[];
  } | null>(null);
  const [slotCount, setSlotCount] = useState<{
    readonly code: string;
    readonly claimed: number;
  } | null>(null);
  const [ownName, setOwnNameState] = useState<string>(() =>
    getOrCreateDisplayName(),
  );
  const handshakes = useRef(0);

  const liveCode = state.kind === "live" ? state.code : null;

  // The URL names the session once the database holds it, and not before. A
  // code written up front stayed there after a failed create, and Retry
  // reloaded into a join of a session that did not exist.
  useEffect(() => {
    if (liveCode === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("code", liveCode);
    history.replaceState(null, "", url.toString());
  }, [liveCode]);

  // Listen for every participant while the session is live and this device
  // shares its own position. Attached only then: the participants are
  // readable by slot holders of a live session and nobody else, so a
  // listener attached before the claim is refused; and a device that shares
  // nothing is shown nothing. Detached — on `lost`, `closed`, sharing
  // stopped, or unmount — by the effect inside, so no handshake can leave one
  // behind.
  useGatedListener(
    db,
    listen && liveCode !== null ? `sessions/${liveCode}/participants` : null,
    (raw) => {
      if (liveCode === null) return;
      const code = liveCode;
      const data = raw as Record<string, ParticipantData> | null;
      if (!data) {
        setRoster({ code, participants: NO_PARTICIPANTS });
        return;
      }

      // Keyed by slot, so there is no allocation to do here at all: the key
      // *is* the index, arbitrated by the database when the slot was claimed.
      // The registry this replaces derived an index from whatever snapshot
      // each client happened to hold.
      const others: ParticipantInfo[] = [];
      for (const [slotKey, participant] of Object.entries(data)) {
        if (participant.uid === uid) continue;
        const slot = Number(slotKey);
        // The rules cannot produce a key outside 0..4, but a snapshot is
        // still untrusted input to this process.
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PARTICIPANTS) {
          continue;
        }
        others.push({
          uid: participant.uid,
          position: { lat: participant.lat, lng: participant.lng },
          accuracy: participant.accuracy,
          lastSeen: participant.ts,
          index: slot as ParticipantIndex,
          name: sanitizeName(participant.name),
        });
      }

      others.sort((a, b) => a.index - b.index);
      // Whether this means waiting, connected or some_stale is the graph's to
      // decide.
      setRoster({ code, participants: others });
    },
    (error, unanswered) => {
      if (liveCode === null) return false;
      // Refused for a moment, it is attached again: once the rules read own
      // position for this, as they do for the trips and the meeting point, a
      // reconnect is refused until the heartbeat writes the position back.
      // Refused for long, the server has stopped letting this client read —
      // a rules deploy, a revoked token, App Check turning it away — and the
      // session is lost.
      if (!unanswered.becamePersistent) {
        Sentry.addBreadcrumb({
          category: "session",
          level: "warning",
          message: "participants listener refused; attaching again",
          data: { attempts: unanswered.attempts },
        });
        return true;
      }
      console.error("[session] participants listener error:", error);
      Sentry.captureException(error, {
        tags: { phase: "listen", classified: classifyJoinError(error) },
        contexts: sessionContext(liveCode, appCheckConfigured),
      });
      dispatch({
        type: "listenerCancelled",
        code: liveCode,
        details: describeError(error),
      });
      return false;
    },
  );
  // What was read while sharing goes once this device stops sharing: what it
  // is shown is what it may read.
  useEffect(() => {
    if (listen) return;
    setRoster(null);
    setMeetPins(null);
    setTrips(null);
  }, [listen]);
  const rosterKnown = listen && roster !== null && roster.code === liveCode;
  const participants = rosterKnown ? roster.participants : NO_PARTICIPANTS;

  // Count the claims while the session is live. A claim is never released,
  // so a session that has had five people is full for good, however few are
  // present. Invites went by the participants — who come and go — and kept
  // offering a session nobody else could join. `slots` is readable by anyone
  // signed in while the session is fresh, and holds no position or name.
  useEffect(() => {
    if (liveCode === null) return;
    const code = liveCode;
    return onValue(
      ref(db, `sessions/${code}/slots`),
      (snap) => {
        const slots = (snap.val() ?? {}) as SlotMap;
        let claimed = 0;
        for (const [slotKey, holder] of Object.entries(slots)) {
          // Untrusted input, as in the participants listener: the rules
          // allow no other keys, but a snapshot is not the rules.
          const slot = Number(slotKey);
          if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_PARTICIPANTS) {
            continue;
          }
          if (typeof holder === "string") claimed++;
        }
        setSlotCount({ code, claimed });
      },
      (error) => {
        // Refused when this client may no longer read the session, which
        // the participants listener reports as `lost` — or when the rules
        // refuse the claims alone. The count keeps its last value, claims
        // only ever growing, but that second case would quietly bring back
        // invites into full sessions, so it is reported, not swallowed.
        Sentry.captureException(error, {
          tags: { phase: "listen-slots", classified: classifyJoinError(error) },
          contexts: sessionContext(code, appCheckConfigured),
        });
      },
    );
  }, [db, appCheckConfigured, liveCode]);
  // Keyed by code, so a count can only ever describe the live session.
  const claimedSlots =
    slotCount !== null && slotCount.code === liveCode ? slotCount.claimed : 0;

  // The meeting point as every device in the session publishes it, and each
  // one's trip. Readable by the slot holders of a live session who share
  // their own position, and read only while this device does. Refused for a
  // moment after a reconnect — the rules read own position, which the server
  // deleted as the connection dropped — and attached again until it answers;
  // reported only once that has gone on for long, or the rules do not know
  // the node: a client ahead of its rules.
  useGatedListener(
    db,
    listen && liveCode !== null ? `sessions/${liveCode}/meet` : null,
    (raw) => {
      if (liveCode !== null)
        setMeetPins({ code: liveCode, pins: parsePins(raw) });
    },
    (error, unanswered) => {
      if (unanswered.becamePersistent && liveCode !== null) {
        Sentry.captureException(error, {
          tags: { phase: "listen-meet", classified: classifyJoinError(error) },
          contexts: sessionContext(liveCode, appCheckConfigured),
        });
      }
      return true;
    },
  );
  useGatedListener(
    db,
    listen && liveCode !== null ? `sessions/${liveCode}/trips` : null,
    (raw) => {
      if (liveCode !== null)
        setTrips({ code: liveCode, trips: parseTrips(raw) });
    },
    (error, unanswered) => {
      if (unanswered.becamePersistent && liveCode !== null) {
        Sentry.captureException(error, {
          tags: { phase: "listen-trips", classified: classifyJoinError(error) },
          contexts: sessionContext(liveCode, appCheckConfigured),
        });
      }
      return true;
    },
  );
  const peerPins =
    listen && meetPins !== null && meetPins.code === liveCode
      ? meetPins.pins
      : NO_PINS;
  const peerTrips =
    listen && trips !== null && trips.code === liveCode
      ? trips.trips
      : NO_TRIPS;

  /** Record a handshake failure once, in the shape the UI and caller need. */
  const fail = useCallback(
    (
      handshake: number,
      code: SessionErrorCode,
      details: string | null,
    ): SessionFailure => {
      const failure = { code, details };
      dispatch({ type: "failed", handshake, failure });
      return failure;
    },
    [],
  );

  /** The caller went away mid-handshake: back to idle, nothing recorded. */
  const abandon = useCallback(
    (
      handshake: number,
      code: "CREATE_FAILED" | "JOIN_FAILED",
    ): Result<string, SessionFailure> => {
      dispatch({ type: "abandoned", handshake });
      return err({ code, details: "aborted" });
    },
    [],
  );

  /** Create a new live session as the creator (index 0). */
  const createSession = useCallback(
    async (signal: AbortSignal): Promise<Result<string, SessionFailure>> => {
      const handshake = ++handshakes.current;
      dispatch({ type: "started", handshake, role: "create" });

      // Drawn here, but kept off the screen until the database holds it. The
      // code and its share buttons used to appear at this point, before the
      // write below — "usable immediately, even if RTDB is slow or offline".
      // But a joiner can do nothing with a code the database has not accepted:
      // the rules refuse every read of a session that was never written. So a
      // creator whose write had not landed — still connecting, a device that
      // could not connect at all, a code already taken and about to be
      // redrawn — handed out a link that could only read "Session not found".
      let sessionCode = generateCode();

      try {
        // Shared with every other RTDB consumer and already in flight since
        // app start, so this is normally already settled — it is a barrier,
        // not a fetch. It never rejects; an unattested outcome still proceeds.
        await appCheckReady;
        // One atomic write: the session exists whole or not at all. As three
        // sequential writes, a failure between them left a session with
        // `created` and no slot 0, whose code nobody could use. The server
        // stamps `created`, and the rules require it to equal their `now`, so
        // no device clock can shorten or extend the session's 24 hours.
        //
        // `created` is write-once, so a refusal means somebody holds the code
        // already: draw another rather than fail. Reported as CREATE_FAILED,
        // the Retry that followed reloaded into the taken code — and joined a
        // stranger's session when it was still live.
        for (let attempt = 1; ; attempt++) {
          try {
            await withRetry(
              () =>
                update(ref(db, `sessions/${sessionCode}`), {
                  created: serverTimestamp(),
                  creatorUid: uid,
                  "slots/0": uid,
                }),
              signal,
              3,
              isTransientError,
            );
            break;
          } catch (refused) {
            if (isTransientError(refused) || attempt >= MAX_CODE_ATTEMPTS) {
              throw refused;
            }
            sessionCode = generateCode();
          }
        }

        const code = sessionCode;
        const createdAtMs = await withRetry(
          () => readCreated(db, code),
          signal,
          3,
          isTransientError,
        );

        // Torn down while the write was in flight. The session exists, but
        // there is nobody to show it to.
        if (signal.aborted) return abandon(handshake, "CREATE_FAILED");

        // Only now does the code name a session, so only now does it reach
        // the screen, the share buttons and the URL.
        dispatch({
          type: "succeeded",
          handshake,
          code,
          slot: 0,
          createdAtMs,
        });
        return ok(code);
      } catch (thrown) {
        if (signal.aborted) return abandon(handshake, "CREATE_FAILED");
        console.error("[session] create failed:", thrown);
        Sentry.captureException(thrown, {
          tags: { phase: "create", classified: classifyJoinError(thrown) },
          contexts: sessionContext(sessionCode, appCheckConfigured),
        });
        return err(fail(handshake, "CREATE_FAILED", describeError(thrown)));
      }
    },
    [db, uid, appCheckConfigured, appCheckReady, fail, abandon],
  );

  /** Join an existing session. */
  const joinSession = useCallback(
    async (
      sessionCode: string,
      signal: AbortSignal,
    ): Promise<Result<string, SessionFailure>> => {
      const handshake = ++handshakes.current;
      dispatch({ type: "started", handshake, role: "join" });

      // Before anything reaches the database: the code becomes a path, and
      // a mangled link used to fall through to creating a new session, so
      // the joiner sat alone believing they had joined.
      if (!isValidCode(sessionCode)) {
        return err(fail(handshake, "INVALID_CODE", null));
      }

      let attestation = "pending";
      try {
        attestation = (await appCheckReady).reason;

        // Only the two fields the join needs, never the session node. The
        // node includes `participants`, which only slot holders may read —
        // and nobody holds a slot yet at this point, so a whole-node read is
        // refused for every joiner.
        //
        // The `.read` rule is `created > now - 24h`. For a session that was
        // never written, `created` is null and RTDB compares null to a number
        // as false — so a missing session is *denied*, not returned empty,
        // and so is an expired one: on purpose, so that nobody can probe the
        // code space for sessions. Classifying that denial here rather than
        // in the shared catch is what makes SESSION_NOT_FOUND reachable at
        // all; the branch below could never fire against real rules, because
        // `get` throws before it can return a null snapshot.
        //
        // But a denial is a statement about the session only if this device
        // may read at all, so that is checked before the session is blamed —
        // the same proof `claimSlot` demands before it calls a refused claim a
        // lost race. A device that may not read goes to the shared catch,
        // which reports it and calls it a permission failure.
        const field = (name: "created" | "creatorUid") =>
          get(ref(db, `sessions/${sessionCode}/${name}`));
        let snaps;
        try {
          snaps = await withRetry(
            () => Promise.all([field("created"), field("creatorUid")]),
            signal,
            3,
            isTransientError,
          );
        } catch (readRefused) {
          if (
            !signal.aborted &&
            classifyJoinError(readRefused) === "JOIN_PERMISSION_DENIED" &&
            (await canReadAtAll(db))
          ) {
            return err(
              fail(handshake, "SESSION_NOT_FOUND", describeError(readRefused)),
            );
          }
          throw readRefused;
        }
        const created: unknown = snaps[0].val();
        const sessionCreator = snaps[1].val() as string | null;

        // Both or neither under real rules: `creatorUid` is readable only
        // while `created` says the session is fresh. A session with one and
        // not the other is not one this client could join, or time.
        //
        // There is no expiry check of its own here any more. The rules have
        // already refused an expired session above, as not found; the check
        // that stood here compared `created` with this device's clock, so it
        // could fire only when that clock ran fast — refusing a session the
        // server still held open.
        if (!sessionCreator || typeof created !== "number") {
          return err(fail(handshake, "SESSION_NOT_FOUND", null));
        }

        // No client-side count: the database decides. `claimSlot` returns null
        // only when all five write-once keys are genuinely taken, which is a
        // fact about the session rather than this client's view of it.
        const slot = await withRetry(
          () => claimSlot(db, sessionCode, uid, false),
          signal,
          3,
          isTransientError,
        );
        // Torn down while the claim was in flight: the slot may be ours now,
        // and a rejoin will find it, but this run has nobody to report to.
        if (signal.aborted) return abandon(handshake, "JOIN_FAILED");
        if (slot === null) {
          return err(fail(handshake, "SESSION_FULL", null));
        }

        dispatch({
          type: "succeeded",
          handshake,
          code: sessionCode,
          slot,
          createdAtMs: created,
        });
        return ok(sessionCode);
      } catch (thrown) {
        if (signal.aborted) return abandon(handshake, "JOIN_FAILED");
        // No promotion on a failed attestation. It used to relabel any opaque failure
        // as an attestation block, written when a failed attestation was the
        // rare suspected cause. It is not rare: App Check reports ~89% of RTDB
        // requests unverified while enforcement is off, so the promotion fired
        // on nearly every device and buried whatever actually went wrong under
        // "your browser may be blocking storage or attestation". The tag below
        // keeps the signal where it belongs — in telemetry, not in a verdict
        // handed to the user.
        const classified = classifyJoinError(thrown);
        console.error("[session] join failed:", thrown, "→", classified);
        Sentry.captureException(thrown, {
          tags: { phase: "join", classified, attestation },
          contexts: sessionContext(sessionCode, appCheckConfigured),
        });
        return err(fail(handshake, classified, describeError(thrown)));
      }
    },
    [db, uid, appCheckConfigured, appCheckReady, fail, abandon],
  );

  /**
   * Update the local display name.
   *
   * Persisted to localStorage and pushed into state; the `presence` node picks
   * it up on the next tick and writes it, because a name change is one of its
   * admission conditions. This used to reach for a cached position and call
   * the writer directly.
   */
  const setOwnName = useCallback((raw: string) => {
    setOwnNameState(saveDisplayName(raw));
  }, []);

  const close = useCallback(() => {
    dispatch({ type: "closed" });
  }, []);

  return {
    state,
    ownName,
    participants,
    rosterKnown,
    claimedSlots,
    peerPins,
    peerTrips,
    createSession,
    joinSession,
    setOwnName,
    close,
  };
}
