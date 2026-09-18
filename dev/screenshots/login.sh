#!/usr/bin/env bash
#
# Drives the login page in multi-user mode: a wrong password, registering an account, and
# logging in with it, counting every request to register along the way. Screenshots the card
# on the way. Downloads nothing.
#
# Not part of CI. See "Exercising the login page" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/login.sh               build, boot, run, stop
#        dev/screenshots/login.sh --skip-build  reuse the last frontend build
#        dev/screenshots/login.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node login.mjs "$@"
