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
