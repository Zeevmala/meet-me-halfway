/**
 * The presence writer against the real RTDB SDK and emulator.
 *
 * `src/.../presence-rtdb.test.ts` pins the writer's logic with a mocked SDK,
 * which can only encode an assumption about the server: that an onDisconnect
 * runs once, when the connection that registered it drops, and is then
 * forgotten. This checks that assumption where it lives. Before the writer
 * re-armed on reconnect, the second drop below left the participant's last
 * position in the database indefinitely — the privacy policy says it is
 * deleted when the device disconnects.
 *
 * Rules are not under test here, so the namespace is opened up and the client
 * signs in as nobody; `database.rules.test.ts` owns the rules.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import {
  connectDatabaseEmulator,
  getDatabase,
  goOffline,
  goOnline,
  onValue,
  ref,
} from "firebase/database";
import type { Database } from "firebase/database";
import { createPresenceWriter } from "../src/features/live-midpoint/lib/presence-rtdb";

const HOST = "127.0.0.1";
const PORT = 9000;
const NAMESPACE = "presence-disconnect-test";
const CODE = "ABC234";
const PATH = `sessions/${CODE}/participants/1`;

let app: FirebaseApp;
let db: Database;

/** Read through the emulator's REST API, outside the client under test. */
async function stored(path: string = PATH): Promise<unknown> {
  const res = await fetch(
    `http://${HOST}:${PORT}/${path}.json?ns=${NAMESPACE}`,
    {
      headers: { Authorization: "Bearer owner" },
    },
  );
  return res.json();
}

async function eventually(
  predicate: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function connected(want: boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const unsubscribe = onValue(ref(db, ".info/connected"), (snapshot) => {
      if (done || snapshot.val() !== want) return;
      done = true;
      setTimeout(() => unsubscribe());
      resolve();
    });
  });
}

function position(lat: number) {
  return { uid: "u1", lat, lng: 34.78, accuracy: 10, name: "" };
}

beforeAll(async () => {
  const res = await fetch(
    `http://${HOST}:${PORT}/.settings/rules.json?ns=${NAMESPACE}`,
    {
      method: "PUT",
      headers: { Authorization: "Bearer owner" },
      body: JSON.stringify({ rules: { ".read": true, ".write": true } }),
    },
  );
  expect(res.ok).toBe(true);

  app = initializeApp(
    {
      projectId: "demo-meet-me-halfway",
      databaseURL: `https://${NAMESPACE}.firebaseio.com`,
    },
    "presence-disconnect",
  );
  db = getDatabase(app);
  connectDatabaseEmulator(db, HOST, PORT);
});

afterAll(async () => {
  await deleteApp(app);
});

it("removes the position on every dropped connection, not just the first", async () => {
  const writer = createPresenceWriter(db);
  const live = new AbortController().signal;

  await writer.write(CODE, 1, position(32.08), live);
  await eventually(async () => (await stored()) !== null, "first write");

  goOffline(db);
  await eventually(async () => (await stored()) === null, "first drop");

  goOnline(db);
  await connected(true);
  await writer.write(CODE, 1, position(32.09), live);
  await eventually(
    async () => (await stored()) !== null,
    "write after reconnect",
  );

  goOffline(db);
  await eventually(async () => (await stored()) === null, "second drop");
  goOnline(db);
});

// The meeting point each device publishes is deleted the same way as its
// position: privacy.html says nothing of the session's whereabouts outlives
// the people in it.
it("removes the copy of the meeting point on every dropped connection too", async () => {
  const writer = createPresenceWriter(db);
  const live = new AbortController().signal;
  const meet = `sessions/${CODE}/meet/1`;
  const pin = {
    at: 1,
    by: 0 as const,
    byName: null,
    lat: 32.79,
    lng: 34.99,
    name: null,
  };

  await writer.writeMeet(CODE, 1, pin, live);
  await eventually(async () => (await stored(meet)) !== null, "first write");
  // Without a name there is no name field: RTDB would refuse an undefined
  // one, and the rules a null one.
  expect(await stored(meet)).toEqual({ at: 1, by: 0, lat: 32.79, lng: 34.99 });

  goOffline(db);
  await eventually(async () => (await stored(meet)) === null, "first drop");

  goOnline(db);
  await connected(true);
  await writer.writeMeet(CODE, 1, { ...pin, at: 2 }, live);
  await eventually(
    async () => (await stored(meet)) !== null,
    "write after reconnect",
  );

  goOffline(db);
  await eventually(async () => (await stored(meet)) === null, "second drop");
  goOnline(db);
});

// So is each device's trip: its route starts where the device is.
it("removes the trip on every dropped connection too", async () => {
  const writer = createPresenceWriter(db);
  const live = new AbortController().signal;
  const trip = `sessions/${CODE}/trips/1`;
  const value = {
    lat: 32.0,
    lng: 34.9,
    profile: "driving" as const,
    duration: 1_800,
    distance: 24_000,
    line: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
  };

  await writer.writeTrip(CODE, 1, value, live);
  await eventually(async () => (await stored(trip)) !== null, "first write");
  expect(await stored(trip)).toEqual(value);

  goOffline(db);
  await eventually(async () => (await stored(trip)) === null, "first drop");

  goOnline(db);
  await connected(true);
  await writer.writeTrip(CODE, 1, { ...value, duration: 1_700 }, live);
  await eventually(
    async () => (await stored(trip)) !== null,
    "write after reconnect",
  );

  goOffline(db);
  await eventually(async () => (await stored(trip)) === null, "second drop");
  goOnline(db);
});
