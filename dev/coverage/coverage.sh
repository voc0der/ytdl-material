#!/usr/bin/env bash
#
# Measures line coverage across both trees and prints the number the README badge uses.
#
# Deliberately not part of CI: the number moves slowly enough that a manual refresh when
# the badge looks stale is the better trade -- see CONTRIBUTING.md.
#
# A run used to leave the working tree dirty, because the backend suite rewrote appdata/
# and the sample media in backend/test/. It no longer does, and the check at the end of
# this script is the canary for that going wrong again rather than a standing instruction.
#
# Usage: dev/coverage/coverage.sh [frontend|backend]
#        (no argument runs both)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

say() { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m==>\033[0m %s\n' "$*" >&2; }

# Files that are generated, are type declarations, or exist only to support the tests.
# None of them are things anyone can write a meaningful test for, and the ~140 generated
# api-types models would otherwise dominate the frontend figure.
FRONTEND_EXCLUDES=(
  --coverage-exclude 'src/api-types/**'
  --coverage-exclude 'src/**/*.d.ts'
  --coverage-exclude 'src/testing/**'
  --coverage-exclude 'src/test-setup.ts'
)

run_frontend() {
  say "frontend (vitest + v8)"
  cd "$ROOT"
  npx ng test --watch=false --coverage \
    --coverage-include 'src/**/*.ts' \
    "${FRONTEND_EXCLUDES[@]}" \
    --coverage-reporters lcovonly \
    > "$ROOT/coverage/frontend-run.log" 2>&1 || {
      tail -30 "$ROOT/coverage/frontend-run.log" >&2
      warn "frontend run failed (full log: coverage/frontend-run.log)"
      return 1
    }
}

run_backend() {
  say "backend (c8 + mocha)"
  cd "$ROOT/backend"

  # authentication/ldap.js is only exercised when there is a directory to talk to;
  # without one those tests skip and the file reads as almost entirely uncovered.
  if "$ROOT/dev/ldap/ldap-server.sh" status 2>/dev/null | grep -q running; then
    # Take the URL the harness is actually listening on rather than assuming the default
    # port, so a server started with YTDL_LDAP_PORT set is still the one the tests use.
    if [ -z "${YTDL_TEST_LDAP_URL:-}" ]; then
      eval "$("$ROOT/dev/ldap/ldap-server.sh" env | sed 's/^/export /')"
      say "using the local LDAP server at $YTDL_TEST_LDAP_URL"
    fi
  else
    warn "no local LDAP server running -- authentication/ldap.js will be understated."
    warn "start one with: dev/ldap/ldap-server.sh start"
  fi

  # public/ holds the compiled frontend bundles, which would swamp everything else.
  npx c8 --all --src . \
    --include '*.js' \
    --include 'authentication/**/*.js' \
    --include 'lowdb-compat/**/*.js' \
    --exclude '*.config.js' \
    --exclude 'test/**' \
    --exclude 'public/**' \
    --exclude 'coverage/**' \
    --reporter=lcovonly \
    npx mocha test --exit -s 1000 \
    > "$ROOT/backend/coverage-run.log" 2>&1 || {
      tail -30 "$ROOT/backend/coverage-run.log" >&2
      warn "backend run failed (full log: backend/coverage-run.log)"
      return 1
    }
}

mkdir -p "$ROOT/coverage"

case "${1:-both}" in
  frontend) run_frontend;;
  backend)  run_backend;;
  both)     run_frontend; run_backend;;
  *) warn "unknown target: $1 (expected frontend, backend, or nothing)"; exit 1;;
esac

node "$HERE/summarize.mjs"

# The suite is supposed to leave these alone. Warn only if it did not, so this stays a
# canary rather than a step everyone learns to perform by reflex.
if [ "${1:-both}" != "frontend" ]; then
  dirtied="$(git -C "$ROOT" status --porcelain -- backend/appdata backend/test 2>/dev/null)"
  if [ -n "$dirtied" ]; then
    warn "the backend suite left changes behind -- it is not supposed to:"
    printf '%s\n' "$dirtied"
    warn "revert them before committing: git checkout -- backend/appdata backend/test"
  fi
fi
