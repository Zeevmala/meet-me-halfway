/**
 * The slot this device last held, per session code.
 *
 * The RTDB claim is keyed by `auth.uid`, and an anonymous uid is not durable:
 * iOS Safari evicts IndexedDB under ITP, and `firebase-factory`'s persistence
 * chain falls through to in-memory in strict-privacy browsers, where every
 * load mints a fresh one. `claimSlot` recognises a rejoin by uid, so across
 * that change the same person came back as a stranger and took a new slot —
 * a new colour, and their previous marker left behind as a ghost.
 *
 * This is the second opinion on "have I been here before": remembered locally,
 * checked against the database, and only ever acted on when the slot is
 * genuinely free or vacated. A stale or forged value therefore cannot take a
 * live participant's slot — the rules would refuse it anyway.
 *
 * Storage is best-effort. Under the same strict-privacy settings that cause
 * the uid to churn, `localStorage` may itself be blocked; the caller falls
 * back to ordinary lowest-free allocation and everything still works, just
 * with a different colour.
 */
import { MAX_PARTICIPANTS } from "./participant-config";
import type { ParticipantIndex } from "./participant-config";

const KEY_PREFIX = "mmhw:slot:";

function key(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

/** The slot last held in this session on this device, if any. */
export function recallSlot(code: string): ParticipantIndex | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(code));
  } catch {
    return null; // private mode / storage disabled
  }
  // A single digit, and nothing else: `Number("")` is 0, which is a valid
  // slot, so a blank entry would otherwise read back as the creator's.
  if (raw === null || !/^\d$/.test(raw)) return null;

  const slot = Number(raw);
  if (slot >= MAX_PARTICIPANTS) return null;
  return slot as ParticipantIndex;
}

/** Remember the slot just claimed, so a reload can ask for it back. */
export function rememberSlot(code: string, slot: ParticipantIndex): void {
  try {
    localStorage.setItem(key(code), String(slot));
  } catch {
    /* ignore — allocation falls back to lowest-free */
  }
}
