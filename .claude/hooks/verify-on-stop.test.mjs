// node --test .claude/hooks/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRelevant,
  scanDiff,
  scanNewFile,
  splitNul,
  vitestArgs,
} from "./verify-on-stop.mjs";

const diff = (path, hunks) =>
  [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join("\n");

test("relevance: the web package counts, docs and other trees do not", () => {
  assert.ok(
    isRelevant("apps/web/src/features/live-midpoint/LiveMidpointPage.tsx"),
  );
  assert.ok(isRelevant("apps/web/package-lock.json"));
  assert.ok(!isRelevant("apps/web/README.md"));
  assert.ok(!isRelevant("CLAUDE.md"));
  assert.ok(!isRelevant(".claude/hooks/verify-on-stop.mjs"));
});

test("splitNul drops the trailing terminator", () => {
  assert.deepEqual(splitNul("a\0b c\0"), ["a", "b c"]);
  assert.deepEqual(splitNul(""), []);
});

test("scan flags skipped, focused and todo tests on added lines with new-file line numbers", () => {
  const found = scanDiff(
    diff("apps/web/src/a.test.ts", [
      "@@ -10,0 +11,3 @@",
      '+  it.skip("x", () => {});',
      '+  describe.only("y", () => {});',
      '+  it.concurrent.todo("z");',
    ]),
  );
  assert.deepEqual(
    found.map((f) => [f.line, f.label]),
    [
      [11, "skipped/focused test"],
      [12, "skipped/focused test"],
      [13, "skipped/focused test"],
    ],
  );
});

test("scan flags suppressions and any-casts, but not removed lines", () => {
  const found = scanDiff(
    diff("apps/web/src/b.ts", [
      "@@ -1,2 +1,4 @@",
      "-  // @ts-ignore",
      "-  const old = x as any;",
      "+  // @ts-expect-error -- untyped lib",
      "+  // eslint-disable-next-line no-console",
      "+  const v = y as any;",
      "+  const fine = z as unknown;",
    ]),
  );
  assert.deepEqual(
    found.map((f) => [f.line, f.label]),
    [
      [1, "TypeScript suppression"],
      [2, "eslint suppression"],
      [3, "`as any` cast"],
    ],
  );
});

test("the +++ header and a removed line starting with '-- ' are not content", () => {
  const found = scanDiff(
    diff("apps/web/src/eslint-disable.ts", [
      "@@ -1 +1 @@",
      "--- eslint-disable",
      "+ok",
    ]),
  );
  assert.deepEqual(found, []);
});

test("scan counts net assertion loss per test file", () => {
  const found = scanDiff(
    diff("apps/web/src/d.test.tsx", [
      "@@ -5,3 +5,1 @@",
      "-    expect(a).toBe(1);",
      "-    expect(b).toBe(2);",
      "-    expect.soft(c).toBe(3);",
      "+    expect(a).toBeTruthy();",
    ]),
  );
  assert.deepEqual(
    found.map((f) => f.label),
    ["net -2 assertion(s)"],
  );
});

test("scan ignores non-code files and deleted files", () => {
  assert.deepEqual(
    scanDiff(
      diff("apps/web/src/i18n/en.json", ["@@ -1 +1 @@", '+"as any": 1']),
    ),
    [],
  );
  const deleted = [
    "diff --git a/apps/web/src/e.ts b/apps/web/src/e.ts",
    "deleted file mode 100644",
    "--- a/apps/web/src/e.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x as any",
  ].join("\n");
  assert.deepEqual(scanDiff(deleted), []);
});

test("a new file is scanned whole", () => {
  const found = scanNewFile(
    "apps/web/src/new/f.test.ts",
    'import x from "y";\nit.only("z", () => {});\n',
  );
  assert.deepEqual(
    found.map((f) => [f.file, f.line]),
    [["apps/web/src/new/f.test.ts", 2]],
  );
});

test("vitest runs related tests while only src/ changed, else everything", () => {
  const f = (path, deleted = false) => ({ path, deleted });
  assert.deepEqual(
    vitestArgs([f("apps/web/src/a.ts"), f("apps/web/src/b.tsx")]),
    ["related", "--run", "--passWithNoTests", "src/a.ts", "src/b.tsx"],
  );
  assert.deepEqual(
    vitestArgs([f("apps/web/src/a.ts"), f("apps/web/vite.config.ts")]),
    ["run"],
  );
  assert.deepEqual(vitestArgs([f("apps/web/src/a.ts", true)]), ["run"]);
});
