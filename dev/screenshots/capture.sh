#!/usr/bin/env bash
#
# Regenerates docs/images/readme-home.png, the screenshot at the top of the README.
#
# Builds the frontend from the working tree, boots the backend against a throwaway
# library of NASA videos (dev/screenshots/fixtures), and captures the home page in
# headless Chromium. Nothing it runs touches backend/appdata or backend/public: the
# build is cached under ~/.cache/ytdl-material/screenshots, and the backend copy and
# its data are staged in the system temp dir, both printed as it runs.
#
# Not part of CI. See "Regenerating the README screenshot" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/capture.sh               build, boot, capture, stop
#        dev/screenshots/capture.sh --skip-build  reuse the last frontend build
#        dev/screenshots/capture.sh --keep        leave the backend running afterwards

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

die() { printf '\033[0;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is not installed"
[ -d "$ROOT/node_modules" ] || die "frontend dependencies are missing; run: npm ci"
[ -d "$ROOT/backend/node_modules" ] || die "backend dependencies are missing; run: npm ci --prefix backend"

cd "$HERE"

# npm writes node_modules/.package-lock.json on every install, so a lockfile newer than it
# means a merged bump has not been installed here yet.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  printf '\033[0;36m==>\033[0m %s\n' "Installing Playwright..."
  npm ci --silent
fi

# Every run, not only the first: each Playwright release pins its own Chromium build, so
# node_modules can be current while the browser it expects was never downloaded. It is
# a no-op when that build is already installed.
npx playwright install chromium

exec node capture.mjs "$@"
