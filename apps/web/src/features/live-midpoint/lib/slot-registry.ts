/**
 * Stable participant slot allocation.
 *
 * A "slot" is a {@link ParticipantIndex} (0-4). It drives the participant's
 * colour, their Mapbox layer ids (`route-{i}`, `accuracy-{i}`) and the
 * attribution of routes — so it must be *stable for the lifetime of a
 * session*. Once a uid holds a slot it keeps it, even while other
 * participants come and go.
 *
 * The previous scheme derived the index as a dense rank over the set of
 * participants currently holding position data, recomputed on every snapshot.
 * That broke three ways:
 *
 *  1. A departure renumbered every lexicographically-later uid, so colours and
 *     route attribution silently shifted under the remaining participants.
 *  2. Own index was ranked over `participantUids` (the write-once registration
 *     set) while other participants were ranked over `participants` (those who
 *     had written a position). The two sets diverge for as long as somebody is
 *     registered but has not yet reported a fix — the normal state during the
 *     first seconds — so own and another participant could hold one slot.
 *  3. The out-of-range clamp aliased surplus uids onto the last slot instead
 *     of rejecting them.
 *
 * Allocation here is first-seen-wins and deterministic: slot 0 is reserved for
 * the session creator, and newcomers take the lowest free slot in arrival
 * order, breaking ties lexicographically so that a snapshot's key order does
 * not affect the result.
 */
import { MAX_PARTICIPANTS } from "./participant-config";
import type { ParticipantIndex } from "./participant-config";

/** Slot reserved for the session creator, so "creator is green" holds. */
const CREATOR_SLOT: ParticipantIndex = 0;

export interface SlotRegistry {
  /**
   * Resolve `uid` to its slot, allocating one on first sight.
   * Returns `null` when every slot is taken — the caller drops the
   * participant rather than aliasing them onto an occupied slot.
   */
  readonly assign: (uid: string) => ParticipantIndex | null;
  /**
   * Allocate slots for a whole snapshot at once. Newcomers are sorted before
   * allocation so the outcome does not depend on object key order.
   */
  readonly assignAll: (uids: readonly string[]) => void;
  /** Slot already held by `uid`, or `null` if it has never been seen. */
  readonly slotOf: (uid: string) => ParticipantIndex | null;
  /** Number of slots currently allocated. */
  readonly size: () => number;
}

/**
 * Create a slot registry for one session.
 *
 * @param creatorUid - Session creator; always receives slot 0. Pass `""` when
 *   the creator is not yet known — slot 0 then stays reserved until they
 *   appear, which keeps the colour contract stable rather than handing 0 to
 *   whoever happens to arrive first.
 */
export function createSlotRegistry(creatorUid: string): SlotRegistry {
  const slots = new Map<string, ParticipantIndex>();
  const taken = new Set<ParticipantIndex>();

  function claim(uid: string, slot: ParticipantIndex): ParticipantIndex {
    slots.set(uid, slot);
    taken.add(slot);
    return slot;
  }

  function assign(uid: string): ParticipantIndex | null {
    const existing = slots.get(uid);
    if (existing !== undefined) return existing;

    if (creatorUid !== "" && uid === creatorUid) {
      return claim(uid, CREATOR_SLOT);
    }

    // Slot 0 stays reserved for the creator; everyone else starts at 1.
    for (let i = CREATOR_SLOT + 1; i < MAX_PARTICIPANTS; i++) {
      const candidate = i as ParticipantIndex;
      if (!taken.has(candidate)) return claim(uid, candidate);
    }
    return null;
  }

  function assignAll(uids: readonly string[]): void {
    const newcomers = uids.filter((uid) => !slots.has(uid));
    // Sort only the newcomers: already-allocated uids must not move.
    for (const uid of [...newcomers].sort()) assign(uid);
  }

  function slotOf(uid: string): ParticipantIndex | null {
    return slots.get(uid) ?? null;
  }

  return { assign, assignAll, slotOf, size: () => slots.size };
}
