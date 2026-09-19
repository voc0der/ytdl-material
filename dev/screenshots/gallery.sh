#!/usr/bin/env bash
#
# Regenerates docs/images/gallery, the screenshots on the documentation's Gallery page.
#
# Stages the README library with subscriptions, a download queue, notifications and task
# history on top, boots the backend against it, and captures each page at a desktop and a
# phone size in headless Chromium. Needs ffmpeg to turn each thumbnail into a clip the player
# can show. Downloads nothing.
#
# Not part of CI. See "Regenerating the gallery" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/gallery.sh               build, boot, capture, stop
#        dev/screenshots/gallery.sh --skip-build  reuse the last frontend build
#        dev/screenshots/gallery.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node gallery.mjs "$@"
