#!/usr/bin/env bash
#
# Drives the Archive dialog and the confirmation it opens: seeds an archive, opens the dialog
# from the toolbar menu, filters and sorts it, removes everything through the confirmation,
# imports an archive file and exports one back out, checking what the backend recorded at each
# step. Screenshots the dialog on the way. Downloads nothing.
#
# Not part of CI. See "Exercising the dialogs" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/dialogs.sh               build, boot, run, stop
#        dev/screenshots/dialogs.sh --skip-build  reuse the last frontend build
#        dev/screenshots/dialogs.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node dialogs.mjs "$@"
