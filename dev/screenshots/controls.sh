#!/usr/bin/env bash
#
# Drives the player's own controls in Chromium and Firefox: clicking and holding the picture,
# the scrubber and its chapters, the menus, keyboard shortcuts, full screen and theater mode.
# Needs ffmpeg to make the clips. Downloads nothing.
#
# Not part of CI. See "Exercising the player's controls" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/controls.sh               build, boot, run, stop
#        dev/screenshots/controls.sh --skip-build  reuse the last frontend build
#        dev/screenshots/controls.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

# The only harness that needs Firefox, which is why the controls are the player's own.
npx playwright install firefox

exec node controls.mjs "$@"
