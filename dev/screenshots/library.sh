#!/usr/bin/env bash
#
# Drives the playlist editor and the Duplicates page: stages the README library with a few
# videos downloaded twice, creates a playlist from New playlist, reorders and renames it, and
# cleans up every duplicate both ways, checking what the backend recorded at each step. Runs
# against a production build, which is the only place NG0919 shows. Downloads nothing.
#
# Not part of CI. See "Exercising the library" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/library.sh               build, boot, run, stop
#        dev/screenshots/library.sh --skip-build  reuse the last frontend build
#        dev/screenshots/library.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node library.mjs "$@"
