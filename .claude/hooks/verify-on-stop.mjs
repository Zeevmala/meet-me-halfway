#!/usr/bin/env node
// Stop hook: runs the web app's CI checks against everything this branch
// changes before Claude may end a turn. See "Stop hook" in CLAUDE.md.
//
// The hook produces the evidence itself rather than trusting a stamp the agent
// wrote, and it diffs against the merge-base with main rather than the working
// tree, so committing does not hide code from it. It is a fast pre-push loop,
// not a security boundary: CI is the gate that cannot be bypassed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const WEB = "apps/web/";
const CHECK_TIMEOUT_MS = 120_000;
const TAIL_LINES = 60;
const MAX_FINDINGS = 40;

/** Paths whose change can turn a CI check red. Docs cannot. */
export function isRelevant(path) {
  return path.startsWith(WEB) && !path.endsWith(".md");
}

export function splitNul(out) {
  return out.split("\0").filter(Boolean);
}

const CODE = /\.(?:ts|tsx|js|cjs|mjs)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/;
const EXPECT = /\bexpect(?:\.\w+)?\s*\(/g;

// Each of these lets a suite go green without the code being right.
const PATTERNS = [
  [
    /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:skip|only|todo)\b/,
    "skipped/focused test",
  ],
  [/@ts-(?:ignore|expect-error|nocheck)\b/, "TypeScript suppression"],
  [/eslint-disable/, "eslint suppression"],
  [/\bas\s+any\b/, "`as any` cast"],
];

/**
 * Scans a `git diff -U0` for added lines matching PATTERNS and for test files
 * that lose more `expect(` calls than they gain. Pure, so it is unit-tested.
 */
export function scanDiff(diff) {
  const findings = [];
  const expects = new Map();
  let file = null;
  let line = 0;
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    // Header lines are only recognised before the first hunk: a removed line
    // whose content starts with "-- " renders as "--- " too.
    if (raw.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader) {
      if (raw.startsWith("+++ "))
        file = raw === "+++ /dev/null" ? null : raw.slice(6);
      if (!raw.startsWith("@@")) continue;
      inHeader = false;
    }
    if (raw.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
      continue;
    }
    if (!file || !CODE.test(file)) continue;
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      for (const [re, label] of PATTERNS) {
        if (re.test(text))
          findings.push({ file, line, label, text: text.trim() });
      }
      if (TEST.test(file))
        bump(expects, file, (text.match(EXPECT) ?? []).length);
      line++;
    } else if (raw.startsWith("-") && TEST.test(file)) {
      bump(expects, file, -(raw.slice(1).match(EXPECT) ?? []).length);
    }
  }
  for (const [f, net] of expects) {
    if (net < 0)
      findings.push({
        file: f,
        line: 0,
        label: `net ${net} assertion(s)`,
        text: "",
      });
  }
  return findings;
}

function bump(map, key, n) {
  map.set(key, (map.get(key) ?? 0) + n);
}

/** The whole of an untracked file is added lines. */
export function scanNewFile(path, content) {
  const lines = content.split("\n");
  return scanDiff(
    `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((l) => `+${l}`).join("\n"),
  );
}

/**
 * `vitest related` is enough while only src/ changed. A config, lockfile or
 * deletion can affect tests that import nothing that changed, so run them all.
 */
export function vitestArgs(changed) {
  const src = changed.filter((f) => f.path.startsWith(`${WEB}src/`));
  if (src.length !== changed.length || src.some((f) => f.deleted))
    return ["run"];
  return [
    "related",
    "--run",
    "--passWithNoTests",
    ...src.map((f) => f.path.slice(WEB.length)),
  ];
}

export function digestOf(root, changed) {
  const h = createHash("sha256");
  for (const f of [...changed].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const body = f.deleted
      ? "<deleted>"
      : createHash("sha256")
          .update(readFileSync(join(root, f.path)))
          .digest("hex");
    h.update(`${f.path}\0${body}\0`);
  }
  return h.digest("hex").slice(0, 16);
}

function git(root, args) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return r.status === 0 ? r.stdout : null;
}

function mergeBase(root) {
  for (const ref of ["origin/main", "main"]) {
    const sha = git(root, ["merge-base", "HEAD", ref])?.trim();
    if (sha) return sha;
  }
  return "HEAD";
}

function changedFiles(root, base) {
  // Against the merge-base, not HEAD: committed, staged, unstaged and deleted
  // files all count. ls-files lists new files individually, where
  // `git status` would collapse a new directory to one entry.
  const tracked = splitNul(
    git(root, ["diff", "--name-only", "-M", "-z", base]) ?? "",
  );
  const untracked = splitNul(
    git(root, ["ls-files", "-o", "--exclude-standard", "-z"]) ?? "",
  );
  return [...new Set([...tracked, ...untracked])].map((path) => ({
    path,
    deleted: !existsSync(join(root, path)),
    untracked: untracked.includes(path),
  }));
}

/** Resolves a package's bin script so it can run under process.execPath with no shell. */
function bin(web, pkg, name = pkg) {
  const dir = join(web, "node_modules", pkg);
  const { bin: b } = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  );
  return join(dir, typeof b === "string" ? b : b[name]);
}

// Mirrors the lint, typecheck and test jobs in .github/workflows/web.yml, run
// over the whole package as CI runs them. Rules tests need Java and the
// emulator; they stay with CI's `rules` job.
function checks(web, changed) {
  const tsc = bin(web, "typescript", "tsc");
  const vitest = vitestArgs(changed);
  return [
    {
      label: "tsc",
      cmd: "tsc",
      script: tsc,
      args: ["-p", "tsconfig.json", "--pretty", "false"],
    },
    {
      label: "tsc (node)",
      cmd: "tsc",
      script: tsc,
      args: ["-p", "tsconfig.node.json", "--pretty", "false"],
    },
    {
      label: "eslint",
      cmd: "eslint",
      script: bin(web, "eslint"),
      args: [".", "--ext", ".ts,.tsx,.cjs,.js", "--max-warnings=0"],
    },
    {
      label: "prettier",
      cmd: "prettier",
      script: bin(web, "prettier"),
      args: [
        "--check",
        "src/**/*.{ts,tsx,css,json}",
        "rules/**/*.ts",
        "*.{ts,cjs,json}",
      ],
    },
    {
      label: "vitest",
      cmd: "vitest",
      script: bin(web, "vitest"),
      args: vitest,
    },
  ];
}

/** Runs one check; returns null on success, else its label and output tail. */
function run(web, { label, cmd, script, args }) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: web,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    timeout: CHECK_TIMEOUT_MS,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (r.status === 0) return null;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trimEnd();
  const why = r.error ? `${r.error.message}\n` : "";
  const shown = args.length > 8 ? [...args.slice(0, 8), "…"] : args;
  const tail = out.split("\n").slice(-TAIL_LINES).join("\n");
  return {
    label,
    text: `── ${label} — npx ${cmd} ${shown.join(" ")} ──\n${why}${tail}`,
  };
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function main() {
  const input = readStdin();
  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    git(process.cwd(), ["rev-parse", "--show-toplevel"])?.trim();
  if (!root || !git(root, ["rev-parse", "HEAD"])) return 0;
  const web = join(root, WEB);
  const base = mergeBase(root);
  const changed = changedFiles(root, base).filter((f) => isRelevant(f.path));
  if (changed.length === 0) return 0;

  const digest = digestOf(root, changed);
  const cachePath = join(root, ".claude", ".verify-cache.json");
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    // first run, or a corrupt cache: verify from scratch
  }
  const prev = cache.digest === digest ? cache : null;
  const save = (state) => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ digest, ...state }));
  };

  // Claude came back without changing anything: either it judged the failure
  // not its own (red on main) or it is stuck. Let it stop, but tell the user,
  // so a red tree is never reported as done in silence.
  if (prev && !prev.ok && (input.stop_hook_active || prev.surfaced)) {
    save({ ...prev, surfaced: true });
    process.stdout.write(
      JSON.stringify({
        systemMessage: `⚠ verify-on-stop: still failing on this change set — ${prev.failed.join(", ")}`,
      }),
    );
    return 0;
  }

  let failures = [];
  if (!prev?.ok) {
    // A throw here would exit 1, which Claude Code treats as non-blocking: a
    // broken install would let every stop through unverified.
    try {
      failures = checks(web, changed)
        .map((c) => run(web, c))
        .filter(Boolean);
    } catch (e) {
      failures = [
        {
          label: "dependencies",
          text: `${e.message}\nRun \`npm ci\` in apps/web.`,
        },
      ];
    }
  }

  const diff =
    git(root, [
      "diff",
      "-U0",
      "-M",
      "--no-color",
      "--no-ext-diff",
      base,
      "--",
      WEB,
    ]) ?? "";
  const findings = [
    ...scanDiff(diff),
    ...changed
      .filter((f) => f.untracked && !f.deleted && CODE.test(f.path))
      .flatMap((f) =>
        scanNewFile(f.path, readFileSync(join(root, f.path), "utf8")),
      ),
    ...changed
      .filter((f) => f.deleted && TEST.test(f.path))
      .map((f) => ({
        file: f.path,
        line: 0,
        label: "deleted test file",
        text: "",
      })),
  ];
  const showScan = findings.length > 0 && !prev?.scanShown;

  save({
    ok: failures.length === 0,
    failed: failures.map((f) => f.label),
    scanShown: Boolean(prev?.scanShown || findings.length > 0),
    surfaced: false,
  });
  if (failures.length === 0 && !showScan) return 0;

  const parts = [];
  if (failures.length > 0) {
    parts.push(
      `verify-on-stop: ${failures.length} check(s) failed for this branch's changes (vs ${base.slice(0, 7)}).`,
      ...failures.map((f) => f.text),
      "Fix these and stop again. If a failure is not yours (red on main too), say so to the user and " +
        "stop again without changes: the stop is then allowed and the user is shown a warning.",
    );
  }
  if (showScan) {
    parts.push(
      "verify-on-stop: this change set can make a suite pass without testing anything:",
      [
        ...findings
          .slice(0, MAX_FINDINGS)
          .map(
            (f) =>
              `  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.label}${f.text ? `  │ ${f.text}` : ""}`,
          ),
        ...(findings.length > MAX_FINDINGS
          ? [`  …and ${findings.length - MAX_FINDINGS} more`]
          : []),
      ].join("\n"),
      "Fix them, or if each is intentional tell the user why and stop again: this list is shown once per change set.",
    );
  }
  process.stderr.write(`${parts.join("\n\n")}\n`);
  return 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
