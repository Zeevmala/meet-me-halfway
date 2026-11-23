/**
 * The RTDB side of the shared meeting point, behind the graph's port.
 *
 * One participant computes the time-fair point and publishes it here; everyone
 * reads it. Computed per device it would differ per device — each samples the
 * others' positions at its own moment — and five people would navigate to five
 * places. The security rules decide who the one is: the holder of the lowest
 * slot named in the mask.
 */
import { ref, serverTimestamp, set } from "firebase/database";
import type { Database } from "firebase/database";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { PublishedMeeting } from "./fair-point";

/** How RTDB words a rules denial in a rejected write. */
const PERMISSION_DENIED = /permission[_ ]denied/i;

export type WriteMeeting = (
  code: string,
  meeting: PublishedMeeting,
  signal: AbortSignal,
) => Promise<Result<void, ResourceError>>;

export function meetingPath(code: string): string {
  return `sessions/${code}/meeting`;
}

/** What a snapshot of the meeting node holds, once checked. */
export function parseMeeting(value: unknown): PublishedMeeting | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lng, mask } = value as Record<string, unknown>;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    typeof mask !== "string" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  return { point: { lat, lng }, mask };
}

export function createMeetingWriter(db: Database): WriteMeeting {
  return async (code, meeting, signal) => {
    try {
      await set(ref(db, meetingPath(code)), {
        lat: meeting.point.lat,
        lng: meeting.point.lng,
        mask: meeting.mask,
        ts: serverTimestamp(),
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return ok(undefined);
    } catch (thrown) {
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        throw thrown;
      }
      // A denial is an answer, not an outage: the rules of the moment do not
      // let this device publish (it is not the leader they see, or they
      // predate the meeting node). Not retried, not held against the breaker.
      const failure = classifyThrown(thrown);
      return err(
        failure.kind === "NETWORK" && PERMISSION_DENIED.test(failure.detail)
          ? { kind: "DENIED", detail: failure.detail }
          : failure,
      );
    }
  };
}
