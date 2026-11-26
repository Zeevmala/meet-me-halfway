// node --test .claude/hooks/session-start.test.mjs
//
// Runs the real script against a throwaway project with a stub `npm` first on
// PATH, so what is tested is the script's own decisions — when to install,
// when to skip, what a failure leaves behind — and no package is fetched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session-start.sh");

/** A project laid out as the script expects, and a stub npm that logs its calls. */
function project({ npmExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "session-start-"));
  const web = join(root, "apps", "web");
  mkdirSync(web, { recursive: true });
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  cpSync(SCRIPT, join(root, ".claude", "hooks", "session-start.sh"));
  writeFileSync(join(web, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(web, "package-lock.json"), '{"lockfileVersion":3}\n');

  const bin = join(root, "bin");
  const log = join(root, "npm.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/bash\necho "$@" >> "${log}"\n` +
      (npmExit === 0 ? "mkdir -p node_modules\n" : "") +
      `exit ${npmExit}\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);

  const run = (env = { CLAUDE_CODE_REMOTE: "true" }) => {
    const clean = { ...process.env };
    delete clean.CLAUDE_CODE_REMOTE;
    return spawnSync("bash", [join(root, ".claude/hooks/session-start.sh")], {
      env: {
        ...clean,
        ...env,
        CLAUDE_PROJECT_DIR: root,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: "utf8",
    });
  };
  const installs = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  const stamp = join(web, "node_modules", ".session-start.sha256");
  return { root, web, run, installs, stamp };
}

test("outside a cloud session it does nothing", (t) => {
  const p = project();
  t.after(() => rmSync(p.root, { recursive: true, force: true }));

  const result = p.run({});

  assert.equal(result.status, 0);
  assert.deepEqual(p.installs(), []);
});

// Plain `npm install` rewrites package-lock.json under a different npm, and a
// modified lockfile is a change set the Stop hook then verifies; `npm ci`
// refuses the lockfile on a Node older than CI's.
test("installs from the lockfile without writing it back", (t) => {
  const p = project();
  t.after(() => rmSync(p.root, { recursive: true, force: true }));

  const result = p.run();

  assert.equal(result.status, 0);
  assert.equal(p.installs().length, 1);
  assert.match(p.installs()[0], /^install --no-save\b/);
  assert.ok(existsSync(p.stamp));
});

// The hook runs on every start, resume, clear and compact, and holds the
// user's message until it ends.
test("skips the install while nothing that decides it has changed", (t) => {
  const p = project();
  t.after(() => rmSync(p.root, { recursive: true, force: true }));

  p.run();
  const again = p.run();

  assert.equal(again.status, 0);
  assert.equal(p.installs().length, 1);
});

for (const file of ["package.json", "package-lock.json"]) {
  test(`installs again when ${file} changes`, (t) => {
    const p = project();
    t.after(() => rmSync(p.root, { recursive: true, force: true }));

    p.run();
    writeFileSync(join(p.web, file), '{"changed":true}\n');
    p.run();

    assert.equal(p.installs().length, 2);
  });
}

test("installs again when the packages are gone", (t) => {
  const p = project();
  t.after(() => rmSync(p.root, { recursive: true, force: true }));

  p.run();
  rmSync(join(p.web, "node_modules"), { recursive: true });
  p.run();

  assert.equal(p.installs().length, 2);
});

// A stamp left by a failed install would skip the retry, and every check the
// Stop hook runs would fail for the rest of the session.
test("a failed install fails the hook and is retried next time", (t) => {
  const p = project({ npmExit: 1 });
  t.after(() => rmSync(p.root, { recursive: true, force: true }));

  const first = p.run();
  const second = p.run();

  assert.notEqual(first.status, 0);
  assert.ok(!existsSync(p.stamp));
  assert.notEqual(second.status, 0);
  assert.equal(p.installs().length, 2);
});
