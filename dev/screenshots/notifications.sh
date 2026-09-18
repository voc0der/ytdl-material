#!/usr/bin/env bash
#
# Drives the toolbar's notification bell and the panel it opens: seeds a library and one
# notification of each kind, opens the bell, filters by kind, follows a notification to what it
# is about, removes one and clears the rest, checking what the backend recorded at each step.
# Also checks the shape of the library cards behind it. Screenshots on the way. Downloads
# nothing.
#
# Not part of CI. See "Exercising the notifications" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/notifications.sh               build, boot, run, stop
#        dev/screenshots/notifications.sh --skip-build  reuse the last frontend build
#        dev/screenshots/notifications.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node notifications.mjs "$@"
