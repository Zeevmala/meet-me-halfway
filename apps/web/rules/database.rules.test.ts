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

/** The RTDB server-timestamp sentinel, as it travels on the wire. */
const SERVER_TIMESTAMP = { ".sv": "timestamp" };

const CODE = "ABC234";
const CREATOR = "creator-uid";
const JOINERS = ["j1", "j2", "j3", "j4"] as const;
const SIXTH = "j5";

function position(uid: string) {
  return { uid, lat: 32.08, lng: 34.78, accuracy: 10, ts: Date.now() };
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

/**
 * Fill all five slots with participants who are actually *present*.
 *
 * A claim alone no longer holds a slot — the rule releases one whose
 * `participants/{i}` node is gone — so "full" means five live participants.
 */
async function occupyEverySlot(): Promise<void> {
  await as(CREATOR)
    .ref(`sessions/${CODE}/participants/0`)
    .set(position(CREATOR));
  for (let i = 0; i < JOINERS.length; i++) {
    const slot = i + 1;
    await as(JOINERS[i]).ref(`sessions/${CODE}/slots/${slot}`).set(JOINERS[i]);
    await as(JOINERS[i])
      .ref(`sessions/${CODE}/participants/${slot}`)
      .set(position(JOINERS[i]));
  }
}

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
    await occupyEverySlot();

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

  it("refuses to take over a slot whose holder is present", async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);
    await as(JOINERS[0])
      .ref(`sessions/${CODE}/participants/1`)
      .set(position(JOINERS[0]));

    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[1]),
    );

    // …and the original holder is untouched.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.database().ref(`sessions/${CODE}/slots/1`).get();
      expect(snap.val()).toBe(JOINERS[0]);
    });
  });

  /**
   * The claim is released by evidence of absence, not by never.
   *
   * A claim used to be permanent, and the anonymous uid behind it is not:
   * iOS Safari evicts IndexedDB under ITP and the in-memory persistence
   * fallback mints a fresh uid on every load. One person reloading therefore
   * came back as a stranger, left their old claim holding a uid that would
   * never write again, and after five reloads the session was full — for
   * everybody. `onDisconnect` clears `participants/{i}` when a socket drops,
   * so an empty participant node is the database's own evidence that the
   * holder is gone.
   */
  it("lets a slot be reclaimed once its holder's participant node is gone", async () => {
    await as(JOINERS[0]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[0]);
    await as(JOINERS[0])
      .ref(`sessions/${CODE}/participants/1`)
      .set(position(JOINERS[0]));
    await as(JOINERS[0]).ref(`sessions/${CODE}/participants/1`).remove();

    await assertSucceeds(
      as(JOINERS[1]).ref(`sessions/${CODE}/slots/1`).set(JOINERS[1]),
    );
  });

  it("lets a session whose every holder has left be joined again", async () => {
    await occupyEverySlot();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.database().ref(`sessions/${CODE}/participants`).remove();
    });

    await assertSucceeds(as(SIXTH).ref(`sessions/${CODE}/slots/0`).set(SIXTH));
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

  /**
   * Slot 0 used to be pinned to `creatorUid` by the rule, which made "the
   * creator is green" a server invariant — and made slot 0 unrecoverable the
   * moment the creator's anonymous uid changed, which on iOS Safari it does.
   * The colour is cosmetic; the stranded slot was not. Slot 0 is now an
   * ordinary slot, and the creator still gets it because they claim it before
   * anybody else has the code (`claimSlot` tries it last).
   */
  it("treats slot 0 as an ordinary slot", async () => {
    await testEnv.clearDatabase();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx
        .database()
        .ref(`sessions/${CODE}`)
        .set({ created: Date.now(), creatorUid: CREATOR });
    });

    await assertSucceeds(
      as(JOINERS[0]).ref(`sessions/${CODE}/slots/0`).set(JOINERS[0]),
    );
    // Still the writer's own uid, and still not takeable once occupied.
    await assertFails(
      as(JOINERS[1]).ref(`sessions/${CODE}/slots/0`).set(JOINERS[0]),
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
      as(JOINERS[0]).ref(`sessions/${CODE}/created`).set(Date.now()),
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

    await assertFails(as(JOINERS[0]).ref(`sessions/${CODE}`).get());
  });

  /**
   * `created` carries its own `.read` so a refused session read has a cause.
   *
   * The session `.read` rule denies a session that does not exist *and* one
   * that has expired, and permission_denied is permission_denied: the client
   * could only report its catch-all, which reads "your browser may be blocking
   * storage or attestation" — for a mistyped link, a day-old link, or a link
   * shared a second before the creator's writes landed. Reading `created` on
   * its own separates absent (null), expired (readable, session refused) and
   * genuinely refused (this read fails too).
   */
  describe("created — the probe that gives a refusal its cause", () => {
    it("is readable when the session does not exist", async () => {
      await testEnv.clearDatabase();
      const snap = await assertSucceeds(
        as(JOINERS[0]).ref(`sessions/${CODE}/created`).get(),
      );
      expect(snap.val()).toBeNull();
    });

    it("is readable when the session has expired", async () => {
      await testEnv.clearDatabase();
      const expired = Date.now() - 25 * 60 * 60 * 1000;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .database()
          .ref(`sessions/${CODE}`)
          .set({ created: expired, creatorUid: CREATOR });
      });

      const snap = await assertSucceeds(
        as(JOINERS[0]).ref(`sessions/${CODE}/created`).get(),
      );
      expect(snap.val()).toBe(expired);
      // …while the session itself stays refused, which is what the client
      // reads as "expired" rather than "your browser is blocking something".
      await assertFails(as(JOINERS[0]).ref(`sessions/${CODE}`).get());
    });

    it("still refuses unauthenticated reads", async () => {
      await assertFails(
        testEnv
          .unauthenticatedContext()
          .database()
          .ref(`sessions/${CODE}/created`)
          .get(),
      );
    });
  });

  /**
   * `created` decides the TTL for everyone, so it cannot come from the
   * writer's clock. A device a day slow used to create a session the very next
   * read rejected — for every joiner, and for the creator's own listener.
   */
  describe("created — must be the server's clock", () => {
    beforeEach(async () => {
      await testEnv.clearDatabase();
    });

    it("accepts the server timestamp sentinel", async () => {
      await assertSucceeds(
        as(CREATOR).ref(`sessions/${CODE}/created`).set(SERVER_TIMESTAMP),
      );
    });

    it("rejects a backdated timestamp", async () => {
      await assertFails(
        as(CREATOR)
          .ref(`sessions/${CODE}/created`)
          .set(Date.now() - 25 * 60 * 60 * 1000),
      );
    });

    it("rejects a timestamp in the future", async () => {
      await assertFails(
        as(CREATOR)
          .ref(`sessions/${CODE}/created`)
          .set(Date.now() + 60 * 60 * 1000),
      );
    });
  });

  it("refuses unauthenticated reads", async () => {
    await assertFails(
      testEnv.unauthenticatedContext().database().ref(`sessions/${CODE}`).get(),
    );
  });

  it("rejects unknown top-level session fields", async () => {
    await assertFails(
      as(JOINERS[0])
        .ref(`sessions/${CODE}/participantUids/${JOINERS[0]}`)
        .set(true),
    );
  });
});
