#!/usr/bin/env bash
#
# Runs real downloads and real tasks through the Downloads and Tasks pages: queues a small
# NASA playlist and a batch that cannot succeed, works the list (pause, resume, retry, page,
# clear), then runs a task, acts on what it found and schedules it. Screenshots each page on
# the way. Downloads from the network.
#
# Not part of CI. See "Exercising downloads and tasks" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/downloads.sh               build, boot, run, stop
#        dev/screenshots/downloads.sh --skip-build  reuse the last frontend build
#        dev/screenshots/downloads.sh --keep        leave the backend running afterwards
#        dev/screenshots/downloads.sh --url URL     download another playlist

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node downloads.mjs "$@"
