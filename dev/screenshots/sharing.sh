#!/usr/bin/env bash
#
# Drives library sharing between two accounts in multi-user mode: one shares its library, the
# other switches to it from Profile, browses and plays it read only, and goes back to its own.
# Checks what the backend recorded at each step, and that the writes a shared library does not
# offer are refused when asked for directly. Downloads nothing.
#
# Not part of CI. See "Exercising library sharing" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/sharing.sh               build, boot, run, stop
#        dev/screenshots/sharing.sh --skip-build  reuse the last frontend build
#        dev/screenshots/sharing.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node sharing.mjs "$@"
