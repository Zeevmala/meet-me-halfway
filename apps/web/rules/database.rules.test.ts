/**
 * Security-rules tests for `infra/database.rules.json`.
 *
 * These run against the Realtime Database emulator, not jsdom, so they live
 * outside `src/` and are driven by `vitest.rules.config.ts` — see the
 * `test:rules` script. The main suite stays emulator-free and fast.
 *
 * The property under test is the one the client can no longer be trusted for:
 * **at most five participants**. `MAX_PARTICIPANTS` used to be a client-side
 * `if` in `joinSession`, so any modified client could register unbounded uids.
 * The cap is now a property of the schema — exactly five write-once keys exist
 * under `slots`, and `participants/{i}` is writable only by whoever holds
 * `slots/{i}`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";

const CODE = "ABC234";
const CREATOR = "creator-uid";
const JOINERS = ["j1", "j2", "j3", "j4"] as const;
const SIXTH = "j5";

/**
 * `serverTimestamp()`'s placeholder. The rules require `created` and `ts` to
 * equal the server's `now`, which only the server can stamp.
 */
const SERVER_NOW = { ".sv": "timestamp" };

function position(uid: string) {
  return { uid, lat: 32.08, lng: 34.78, accuracy: 10, ts: SERVER_NOW };
}

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-meet-me-halfway",
    database: {
      rules: readFileSync(
        resolve(__dirname, "../../../infra/database.rules.json"),
        "utf8",
      ),
      host: "127.0.0.1",
      port: 9000,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

/** A session that exists, is fresh, and has the creator holding slot 0. */
async function seedSession(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .database()
      .ref(`sessions/${CODE}`)
      .set({
        created: Date.now(),
        creatorUid: CREATOR,
        slots: { 0: CREATOR },
      });
  });
}

beforeEach(async () => {
  await testEnv.clearDatabase();
  await seedSession();
});

const as = (uid: string) => testEnv.authenticatedContext(uid).database();

describe("slots — the participant cap", () => {
  it("lets four joiners claim the four remaining slots", async () => {
    for (let i = 0; i < JOINERS.length; i++) {
      await assertSucceeds(
        as(JOINERS[i])
          .ref(`sessions/${CODE}/slots/${i + 1}`)
          .set(JOINERS[i]),
      );
    }
  });

  // THE finding: this is what a client-side `if` could not enforce.
  it("refuses a sixth participant every slot", async () => {
    for (let i = 0; i < JOINERS.length; i++) {
      await as(JOINERS[i])
        .ref(`sessions/${CODE}/slots/${i + 1}`)
        .set(JOINERS[i]);
    }

    for (const slot of [0, 1, 2, 3, 4]) {
      await assertFails(
        as(SIXTH).ref(`sessions/${CODE}/slots/${slot}`).set(SIXTH),
      );
    }
  });

  it("refuses a slot key outside 0..4", async () => {
    for (const key of ["5", "99", "abc", "-1"]) {
      await assertFails(
        as(SIXTH).ref(`sessions/${CODE}/slots/${key}`).set(SIXTH),
      );
    }
  });

  it("is write-once: an occupied slot cannot be taken over", async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);

    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[1]),
    );

    // …and the original holder is untouched.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.database().ref(`sessions/${CODE}/slots/1`).get();
      expect(snap.val()).toBe(JOINERS[0]);
    });
  });

  it("refuses a claim made on someone else's behalf", async () => {
    await assertFails(
      as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[1]),
    );
  });

  it("refuses an unauthenticated claim", async () => {
    await assertFails(
      testEnv
        .unauthenticatedContext()
        .database()
        .ref(`sessions/${CODE}/slots/1`)
        .set("anon"),
    );
  });

  it("reserves slot 0 for the creator", async () => {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .database()
        .ref(`sessions/${CODE}`)
        .set({ created: Date.now(), creatorUid: CREATOR });
    });

    // A joiner cannot take slot 0 even while it is free…
    await assertFails(
      as(JOINERS[0]).ref(`sessions/${CODE}/slots/0`).set(JOINERS[0]),
    );
    // …but the creator can.
    await assertSucceeds(
      as(CREATOR).ref(`sessions/${CODE}/slots/0`).set(CREATOR),
    );
  });
});

describe("participants — writable only by the slot holder", () => {
  beforeEach(async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);
  });

  it("lets the slot holder write their own position", async () => {
    await assertSucceeds(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set(position(JOINERS[0])),
    );
  });

  it("refuses a write to a slot held by someone else", async () => {
    await assertFails(
      as(JOINERS[1])
        .ref(`sessions/${CODE}/participants/1`)
        .set(position(JOINERS[1])),
    );
  });

  it("refuses a write to a slot nobody holds", async () => {
    await assertFails(
      as(JOINERS[1])
        .ref(`sessions/${CODE}/participants/3`)
        .set(position(JOINERS[1])),
    );
  });

  it("refuses a payload whose uid is not the writer", async () => {
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set(position("somebody-else")),
    );
  });

  it("lets the holder clear their own node", async () => {
    await as(JOINERS[0])
      .ref(`sessions/${CODE}/participants/1`)
      .set(position(JOINERS[0]));

    await assertSucceeds(
      as(JOINERS[0]).ref(`sessions/${CODE}/participants/1`).remove(),
    );
  });
});

describe("participants — payload validation (regression)", () => {
  beforeEach(async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);
  });

  const write = (patch: Record<string, unknown>) =>
    as(JOINERS[0])
      .ref(`sessions/${CODE}/participants/1`)
      .set({ ...position(JOINERS[0]), ...patch });

  it("rejects out-of-range latitude and longitude", async () => {
    await assertFails(write({ lat: 91 }));
    await assertFails(write({ lat: -91 }));
    await assertFails(write({ lng: 181 }));
    await assertFails(write({ lng: -181 }));
  });

  it("rejects negative accuracy", async () => {
    await assertFails(write({ accuracy: -1 }));
  });

  it("rejects an over-long display name", async () => {
    await assertFails(write({ name: "x".repeat(31) }));
    await assertSucceeds(write({ name: "x".repeat(30) }));
  });

  it("rejects unknown fields", async () => {
    await assertFails(write({ injected: "nope" }));
  });

  it("rejects a payload missing required fields", async () => {
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set({ uid: JOINERS[0], lat: 32.08 }),
    );
  });
});

describe("session metadata", () => {
  it("keeps created and creatorUid write-once", async () => {
    await assertFails(
      as(JOINERS[0]).ref(`sessions/${CODE}/created`).set(SERVER_NOW),
    );
    await assertFails(
      as(JOINERS[0]).ref(`sessions/${CODE}/creatorUid`).set(JOINERS[0]),
    );
  });

  it("refuses reads of a session older than the 24h TTL", async () => {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .database()
        .ref(`sessions/${CODE}`)
        .set({
          created: Date.now() - 25 * 60 * 60 * 1000,
          creatorUid: CREATOR,
          slots: { 0: CREATOR },
        });
    });

    for (const field of ["created", "creatorUid", "slots", "participants"]) {
      await assertFails(as(CREATOR).ref(`sessions/${CODE}/${field}`).get());
    }
  });

  it("refuses reads of a session that does not exist", async () => {
    // Deliberate, and load-bearing in two directions.
    //
    // `.read` gates on `created > now - 24h`. For a code nobody ever created,
    // `created` is null, and RTDB compares null to a number as false — so the
    // read is denied rather than resolving empty. That is what keeps the code
    // space opaque: without it, any signed-in client could probe 31^6 codes and
    // learn which sessions are live, and a live session is the real-time
    // location of real people. Anonymous auth is free, so the probe is cheap.
    //
    // The cost is that "no such session" and "expired" are one observable.
    // "Forbidden" no longer joins them: before `joinSession` calls a denied
    // session read SESSION_NOT_FOUND, it reads `probe` (below), which answers
    // for the device and never for a session — so a device that may read
    // nothing is told that instead. Relax this rule and the trade — privacy
    // over message fidelity — is reversed.
    await testEnv.clearDatabase();
    await assertFails(as(JOINERS[0]).ref(`sessions/${CODE}/created`).get());
    await assertFails(as(JOINERS[0]).ref(`sessions/${CODE}/creatorUid`).get());
  });

  it("refuses unauthenticated reads", async () => {
    for (const field of ["created", "creatorUid", "slots"]) {
      await assertFails(
        testEnv
          .unauthenticatedContext()
          .database()
          .ref(`sessions/${CODE}/${field}`)
          .get(),
      );
    }
  });

  it("rejects unknown top-level session fields", async () => {
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participantUids/${JOINERS[0]}`)
        .set(true),
    );
  });
});

describe("probe — whether this device may read at all", () => {
  // A denied session read means "no such session" only if the device may read
  // anything. `joinSession` reads this to tell the two apart: without it, a
  // device turned away (no auth token, App Check enforcement) was told the
  // session did not exist. It holds nothing and names no session, so the code
  // space stays as opaque as the test above requires.
  it("is readable by any signed-in client, and holds nothing", async () => {
    const snapshot = await assertSucceeds(as(JOINERS[0]).ref("probe").get());
    expect(snapshot.val()).toBeNull();
  });

  it("refuses an unauthenticated read", async () => {
    await assertFails(
      testEnv.unauthenticatedContext().database().ref("probe").get(),
    );
  });

  it("cannot be written, so it can only ever answer for the device", async () => {
    await assertFails(as(JOINERS[0]).ref("probe").set(true));
    await assertFails(as(JOINERS[0]).ref("probe/session").set(CODE));
  });
});

describe("hardening — holes the review found open", () => {
  /** A session older than the 24h TTL, with a joiner already in slot 1. */
  async function seedExpired(): Promise<void> {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .database()
        .ref(`sessions/${CODE}`)
        .set({
          created: Date.now() - 25 * 60 * 60 * 1000,
          creatorUid: CREATOR,
          slots: { 0: CREATOR, 1: JOINERS[0] },
          participants: { 1: position(JOINERS[0]) },
        });
    });
  }

  // Before: a slot and then a live position could be written under a code
  // nobody had created — a session with no `created`, which no read rule can
  // ever open again, and which nothing deletes.
  it("refuses a slot claim in a session that was never created", async () => {
    await testEnv.clearDatabase();

    await assertFails(
      as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]),
    );
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set(position(JOINERS[0])),
    );
  });

  it("refuses slot 0 in a session that was never created", async () => {
    await testEnv.clearDatabase();
    await as(CREATOR).ref(`sessions/${CODE}/creatorUid`).set(CREATOR);

    await assertFails(as(CREATOR).ref(`sessions/${CODE}/slots/0`).set(CREATOR));
  });

  // Before: any string was a session key, up to RTDB's 768-byte limit.
  it("refuses a session code the client could not have generated", async () => {
    await testEnv.clearDatabase();
    for (const code of [
      "abc234", // lower case
      "ABC23", // too short
      "ABC2345", // too long
      "ABCD0O", // 0 and O are not in the alphabet
      "ILL234", // nor are I and L
      "not-a-code",
    ]) {
      await assertFails(
        as(CREATOR).ref(`sessions/${code}/created`).set(SERVER_NOW),
      );
    }
    await assertSucceeds(
      as(CREATOR).ref(`sessions/ZY98XW/created`).set(SERVER_NOW),
    );
  });

  // Before: reads stopped at 24 hours but writes did not, so a session kept
  // taking new participants and positions that nobody could ever read.
  it("refuses new claims and positions in an expired session", async () => {
    await seedExpired();

    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/slots/2`).set(JOINERS[1]),
    );
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set({ ...position(JOINERS[0]), lat: 32.5 }),
    );
  });

  // The disconnect cleanup must still land after expiry, or a participant
  // still connected at the 24h mark could never be removed.
  it("still lets the holder clear their node in an expired session", async () => {
    await seedExpired();

    await assertSucceeds(
      as(JOINERS[0]).ref(`sessions/${CODE}/participants/1`).remove(),
    );
  });

  // What createSession sends: the whole session in one write, so a failure
  // can no longer leave `created` without its slot 0.
  it("accepts an atomic create of created, creatorUid and slot 0", async () => {
    await testEnv.clearDatabase();

    await assertSucceeds(
      as(CREATOR).ref(`sessions/${CODE}`).update({
        created: SERVER_NOW,
        creatorUid: CREATOR,
        "slots/0": CREATOR,
      }),
    );
  });
});

describe("the handshake the deployed client actually performs", () => {
  // The test the 2026-09-11 outage needed and did not have.
  //
  // Every other case here probes one rule in isolation, which is why a rules
  // file that rejected the client outright still passed CI: nothing replayed
  // the client's real sequence end to end. This does. If `useLiveSession`
  // changes what it writes, or the rules change what they accept, one of these
  // fails here instead of in production. Keep it in step with useLiveSession.ts.

  it("accepts this release's handshake: an atomic create, then a joiner who reads the locations only once in", async () => {
    await testEnv.clearDatabase();
    const creator = as(CREATOR);

    // createSession: one write, server-stamped.
    await assertSucceeds(
      creator.ref(`sessions/${CODE}`).update({
        created: SERVER_NOW,
        creatorUid: CREATOR,
        "slots/0": CREATOR,
      }),
    );
    await assertSucceeds(creator.ref(`sessions/${CODE}/participants`).get());
    await assertSucceeds(
      creator.ref(`sessions/${CODE}/participants/0`).set(position(CREATOR)),
    );

    // joinSession: read `created` and `creatorUid` field by field, read the
    // slot map, claim the lowest free index — and only then listen to the
    // participants and publish.
    const joiner = as(JOINERS[0]);
    await assertSucceeds(joiner.ref(`sessions/${CODE}/created`).get());
    await assertSucceeds(joiner.ref(`sessions/${CODE}/creatorUid`).get());
    await assertSucceeds(joiner.ref(`sessions/${CODE}/slots`).get());
    await assertFails(joiner.ref(`sessions/${CODE}/participants`).get());
    await assertSucceeds(
      joiner.ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]),
    );
    await assertSucceeds(joiner.ref(`sessions/${CODE}/participants`).get());
    await assertSucceeds(
      joiner.ref(`sessions/${CODE}/participants/1`).set(position(JOINERS[0])),
    );
  });

  // Tabs loaded from the previous release create with three writes; until
  // each has reloaded, the rules must still accept them.
  it("still accepts the previous release's sequential create", async () => {
    await testEnv.clearDatabase();
    const creator = as(CREATOR);

    await assertSucceeds(
      creator.ref(`sessions/${CODE}/created`).set(SERVER_NOW),
    );
    await assertSucceeds(
      creator.ref(`sessions/${CODE}/creatorUid`).set(CREATOR),
    );
    await assertSucceeds(creator.ref(`sessions/${CODE}/slots/0`).set(CREATOR));
  });

  // The contract step drops the shape the client before the expand step
  // sent. A tab still running it is refused until it reloads: it read the
  // whole session, and stamped `created` and `ts` with the device's clock.
  it("refuses the pre-expand client: a whole-session read, device timestamps", async () => {
    await testEnv.clearDatabase();
    const creator = as(CREATOR);
    const deviceClock = Date.now() - 60_000;

    await assertFails(creator.ref(`sessions/${CODE}/created`).set(deviceClock));
    await assertSucceeds(
      creator.ref(`sessions/${CODE}/created`).set(SERVER_NOW),
    );
    await assertSucceeds(
      creator.ref(`sessions/${CODE}/creatorUid`).set(CREATOR),
    );
    await assertSucceeds(creator.ref(`sessions/${CODE}/slots/0`).set(CREATOR));
    await assertFails(
      creator
        .ref(`sessions/${CODE}/participants/0`)
        .set({ ...position(CREATOR), ts: deviceClock }),
    );
    await assertFails(as(JOINERS[0]).ref(`sessions/${CODE}`).get());
  });

  it("refuses slot 0 until creatorUid exists, which is why the order is fixed", async () => {
    await testEnv.clearDatabase();
    const creator = as(CREATOR);

    await assertSucceeds(
      creator.ref(`sessions/${CODE}/created`).set(SERVER_NOW),
    );
    // slots/0 validates its value against creatorUid, so claiming before that
    // write lands can never pass. This pins the ordering comment in
    // createSession to something executable.
    await assertFails(creator.ref(`sessions/${CODE}/slots/0`).set(CREATOR));
  });

  it("lets claimSlot tell a lost race from a structural denial", async () => {
    // claimSlot re-reads the index it was refused: a holder means a lost race,
    // null means the write was denied for another reason. Both reads have to be
    // permitted for that distinction to be drawable at all.
    await assertSucceeds(as(JOINERS[0]).ref(`sessions/${CODE}/slots/0`).get());
    await assertSucceeds(as(JOINERS[0]).ref(`sessions/${CODE}/slots/3`).get());
  });
});

describe("reads — locations for the people in the session only", () => {
  // Before: anyone signed in who had the code could read every live location,
  // including a sixth person refused a slot. The code was the only key, and
  // codes can be guessed.
  beforeEach(async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);
    await as(JOINERS[0])
      .ref(`sessions/${CODE}/participants/1`)
      .set(position(JOINERS[0]));
  });

  it("lets every slot holder read the locations", async () => {
    await assertSucceeds(
      as(CREATOR).ref(`sessions/${CODE}/participants`).get(),
    );
    await assertSucceeds(
      as(JOINERS[0]).ref(`sessions/${CODE}/participants`).get(),
    );
  });

  it("refuses them to anyone holding no slot", async () => {
    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/participants`).get(),
    );
    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/participants/1`).get(),
    );
  });

  it("refuses them to someone left out of a full session", async () => {
    for (const [i, uid] of JOINERS.entries()) {
      if (i > 0) {
        await as(uid)
          .ref(`sessions/${CODE}/slots/${i + 1}`)
          .set(uid);
      }
    }

    await assertFails(as(SIXTH).ref(`sessions/${CODE}/participants`).get());
  });

  it("refuses a read of the whole session, even to a holder", async () => {
    await assertFails(as(CREATOR).ref(`sessions/${CODE}`).get());
  });

  // The join reads these before holding a slot, so they stay open to anyone
  // signed in while the session is fresh: when it began, who started it, and
  // which anonymous IDs hold slots — no position, no name.
  it("leaves created, creatorUid and slots readable for the join", async () => {
    for (const field of ["created", "creatorUid", "slots"]) {
      await assertSucceeds(
        as(JOINERS[1]).ref(`sessions/${CODE}/${field}`).get(),
      );
    }
  });
});

describe("timestamps — the server's clock, not the device's", () => {
  // `created` set the 24-hour window and `ts` every peer's idea of who is
  // stale; both were whatever the device said. A client could backdate or
  // postdate either, and the 2s write throttle compared values it chose.
  it("refuses a created that is not the server's now", async () => {
    await testEnv.clearDatabase();

    await assertFails(
      as(CREATOR)
        .ref(`sessions/${CODE}/created`)
        .set(Date.now() + 86_400_000),
    );
    await assertFails(
      as(CREATOR)
        .ref(`sessions/${CODE}/created`)
        .set(Date.now() - 60_000),
    );
  });

  it("refuses a ts that is not the server's now", async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);

    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participants/1`)
        .set({ ...position(JOINERS[0]), ts: Date.now() + 60_000 }),
    );
  });
});
