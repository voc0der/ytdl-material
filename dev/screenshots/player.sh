#!/usr/bin/env bash
#
# Drives the list under the player: stages the README library with every file a short clip
# that really plays, plays a playlist through with Autoplay and Repeat, reorders it by
# dragging, and turns a file played on its own into the library with Autoplay. Needs ffmpeg
# to make the clip. Downloads nothing.
#
# Not part of CI. See "Exercising the player's list" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/player.sh               build, boot, run, stop
#        dev/screenshots/player.sh --skip-build  reuse the last frontend build
#        dev/screenshots/player.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node player.mjs "$@"
