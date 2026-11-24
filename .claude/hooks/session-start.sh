#!/bin/bash
# SessionStart hook: installs the web app's dependencies in Claude Code cloud
# sessions, so the Stop hook (tsc, eslint, prettier, vitest) has something to
# run. Without node_modules every one of its checks fails on a fresh container.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}/apps/web"

# Run the install only if a file that decides what gets installed has changed
# since the install last succeeded. The hash file lives in node_modules, so it
# disappears with the packages.
#
# `npm install --no-save`, which installs what the lockfile says and writes
# nothing back. Plain `npm install` rewrites package-lock.json whenever the
# container's npm differs from the one that wrote it, and a modified file under
# apps/web is a change set the Stop hook then verifies — in a session that
# changed nothing. `npm ci` refuses outright: CI runs Node 24, and an older
# npm (the container's, at the time of writing) resolves the lockfile's
# optional peers differently and calls it out of sync.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  npm install --no-save --no-audit --no-fund --loglevel=error
  sha256sum ../../.claude/hooks/session-start.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
fi
