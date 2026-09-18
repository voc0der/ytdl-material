#!/usr/bin/env bash
#
# Drives the Settings page tab by tab: opens each one, changes a setting of every kind the page
# has, saves, and reads the config back off the backend to check what was picked is what was
# stored. Also works the categories list and the dialogs the page opens. Screenshots every tab
# on the way. Downloads nothing.
#
# Not part of CI. See "Exercising the settings page" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/settings.sh               build, boot, run, stop
#        dev/screenshots/settings.sh --skip-build  reuse the last frontend build
#        dev/screenshots/settings.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node settings.mjs "$@"
