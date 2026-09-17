#!/usr/bin/env bash
#
# Regenerates docs/images/readme-home.png, the screenshot at the top of the README.
#
# Builds the frontend from the working tree, boots the backend against a throwaway
# library of NASA videos (dev/screenshots/fixtures), and captures the home page in
# headless Chromium. Nothing it runs touches backend/appdata or backend/public: the
# build, the backend copy and its data all live under the cache dir it prints.
#
# Not part of CI. See "Regenerating the README screenshot" in DEVELOPMENT.md.
#
# Usage: dev/screenshots/capture.sh               build, boot, capture, stop
#        dev/screenshots/capture.sh --skip-build  reuse the last frontend build
#        dev/screenshots/capture.sh --keep        leave the backend running afterwards

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/ensure-playwright.sh"

exec node capture.mjs "$@"
