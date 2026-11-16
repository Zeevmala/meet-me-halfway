#!/usr/bin/env bash
# The gate. The factory runs the default branch's copy of this file after every
# build, on a runner with a read-only token and none of this repo's secrets.
# Mirrors .github/workflows/web.yml: lint, typecheck, test, rules, build.
# Not here: npm audit (network-dependent), e2e and Lighthouse (they stay in web.yml).
set -euo pipefail
export CI=true

(
  cd apps/web
  npx eslint . --ext .ts,.tsx,.cjs,.js --max-warnings=0
  npx prettier --check "src/**/*.{ts,tsx,css,json}" "rules/**/*.ts" "*.{ts,cjs,json}"
  npm run tsc
  npm test
  npm run build
)

# Security rules are where the participant cap and read restrictions live, so they gate too.
# Compatibility: firebase-tools 15 needs Java 21; GitHub's Ubuntu runners ship it beside the default JDK.
if [ -n "${JAVA_HOME_21_X64:-}" ]; then
  export JAVA_HOME="$JAVA_HOME_21_X64"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway \
  "npm --prefix apps/web run test:rules"
