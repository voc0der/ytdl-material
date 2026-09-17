#!/usr/bin/env bash
#
# Runs a real subscription through the subscription pages: subscribes to a small NASA
# playlist from the page, waits for the downloads, checks them again, saves a setting and
# unsubscribes, and screenshots each page on the way. Downloads from the network.
#
# Not part of CI. See "Exercising subscriptions" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/subscriptions.sh               build, boot, run, stop
#        dev/screenshots/subscriptions.sh --skip-build  reuse the last frontend build
#        dev/screenshots/subscriptions.sh --keep        stop before unsubscribing, leave the backend running
#        dev/screenshots/subscriptions.sh --url URL     subscribe to another playlist

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node subscriptions.mjs "$@"
