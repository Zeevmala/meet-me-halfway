#!/usr/bin/env bash
# Runs once before the agent starts. Install what the gate needs; nothing else.
set -euo pipefail
APP_DIR=apps/web   # monorepo: the folder that holds package.json, e.g. apps/web
cd "$APP_DIR"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
