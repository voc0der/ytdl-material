#!/usr/bin/env bash
#
# Stand up a throwaway ytdl-material container and assert things about it.
#
# This exists so an agent (or a human) debugging a user report does not have to
# rediscover how to reproduce one. It is deliberately NOT wired into CI: the live
# download check depends on YouTube's current mood and would turn CI red for
# reasons that have nothing to do with a given change.
#
# Usage:
#   docker-utils/container-repro.sh [options]
#
#   --channel <stable|nightly|master>  yt-dlp update channel to configure (default: stable)
#   --tag <image-tag>                  ytdl-material image tag (default: latest)
#   --uid <uid> / --gid <gid>          runtime UID/GID (default: 1026/100, matching common NAS setups)
#   --local                            mount the working tree's backend/*.js over /app,
#                                      so uncommitted changes are exercised without a rebuild
#   --download [url]                   also attempt a real download (proves/disproves a 403 report)
#   --keep                             leave the container running for manual poking
#   --help
#
# Exit code is non-zero if any check fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHANNEL="stable"
IMAGE_TAG="latest"
RUN_UID="1026"
RUN_GID="100"
USE_LOCAL=0
DO_DOWNLOAD=0
DOWNLOAD_URL="https://www.youtube.com/watch?v=jNQXAC9IVRw"
KEEP=0

while [ $# -gt 0 ]; do
    case "$1" in
        --channel) CHANNEL="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --uid) RUN_UID="$2"; shift 2 ;;
        --gid) RUN_GID="$2"; shift 2 ;;
        --local) USE_LOCAL=1; shift ;;
        --download)
            DO_DOWNLOAD=1
            if [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; then DOWNLOAD_URL="$2"; shift; fi
            shift ;;
        --keep) KEEP=1; shift ;;
        --help|-h) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

IMAGE="voc0der/ytdl-material:${IMAGE_TAG}"
NAME="ytdl-repro-$$"
VOLUME="${NAME}-appdata"

FAILURES=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '  ....  %s\n' "$1"; }

cleanup() {
    if [ "$KEEP" -eq 1 ]; then
        echo
        echo "Container kept as '${NAME}' (volume '${VOLUME}'). Remove with:"
        echo "  docker rm -f ${NAME} && docker volume rm ${VOLUME}"
        return
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The three yt-dlp channels live in separate repos that publish identically named
# tags and assets. Keep this in sync with YTDLP_UPDATE_CHANNELS in backend/youtube-dl.js.
channel_repo() {
    case "$1" in
        stable) echo "yt-dlp/yt-dlp" ;;
        nightly) echo "yt-dlp/yt-dlp-nightly-builds" ;;
        master) echo "yt-dlp/yt-dlp-master-builds" ;;
        *) echo "unknown channel: $1" >&2; exit 2 ;;
    esac
}

echo "ytdl-material container repro"
echo "  image:   ${IMAGE}"
echo "  channel: ${CHANNEL}"
echo "  uid/gid: ${RUN_UID}:${RUN_GID}"
[ "$USE_LOCAL" -eq 1 ] && echo "  source:  working tree (backend/*.js mounted over /app)"
echo

docker volume create "$VOLUME" >/dev/null

RUN_ARGS=(
    -d --name "$NAME"
    --security-opt no-new-privileges:true
    -e UID="$RUN_UID" -e GID="$RUN_GID"
    -e ytdl_default_downloader=yt-dlp
    -e ytdl_ytdlp_update_channel="$CHANNEL"
    -e ytdl_use_local_db=true
    -e write_ytdl_config=true
    -v "${VOLUME}:/app/appdata"
)

# Mounting individual files (rather than the whole backend dir) keeps the image's
# node_modules and built frontend intact. The entrypoint's chown will warn about the
# read-only mounts; that is expected and harmless.
if [ "$USE_LOCAL" -eq 1 ]; then
    for f in youtube-dl.js consts.js config.js downloader.js app.js entrypoint.sh; do
        [ -f "${REPO_ROOT}/backend/${f}" ] && RUN_ARGS+=(-v "${REPO_ROOT}/backend/${f}:/app/${f}:ro")
    done
fi

docker run "${RUN_ARGS[@]}" "$IMAGE" >/dev/null

info "waiting for startup and the yt-dlp update check..."
DEADLINE=$((SECONDS + 180))
while [ $SECONDS -lt $DEADLINE ]; do
    if docker exec "$NAME" test -x /app/appdata/bin/yt-dlp 2>/dev/null; then break; fi
    if ! docker ps --filter "name=${NAME}" --format '{{.Names}}' | grep -q "$NAME"; then
        fail "container exited during startup"
        docker logs "$NAME" 2>&1 | tail -30
        exit 1
    fi
    sleep 5
done

if ! docker exec "$NAME" test -x /app/appdata/bin/yt-dlp 2>/dev/null; then
    fail "yt-dlp binary never appeared at /app/appdata/bin/yt-dlp"
    docker logs "$NAME" 2>&1 | tail -30
    exit 1
fi

run_as_runtime() { docker exec --user "${RUN_UID}:${RUN_GID}" "$NAME" "$@"; }

# --- check: the app runs as the configured user -----------------------------------
ACTUAL_IDS="$(docker exec "$NAME" sh -c "ps -o uid,gid,args -e | grep '[a]pp.js' | head -1 | awk '{print \$1\":\"\$2}'" 2>/dev/null || true)"
if [ "$ACTUAL_IDS" = "${RUN_UID}:${RUN_GID}" ]; then
    pass "app process runs as ${RUN_UID}:${RUN_GID}"
else
    fail "app process runs as '${ACTUAL_IDS}', expected ${RUN_UID}:${RUN_GID}"
fi

# --- check: the configured channel was actually applied ---------------------------
if docker exec "$NAME" grep -q "\"ytdlp_update_channel\": *\"${CHANNEL}\"" /app/appdata/default.json 2>/dev/null; then
    pass "config recorded ytdlp_update_channel=${CHANNEL}"
else
    STORED="$(docker exec "$NAME" sh -c "grep -o '\"ytdlp_update_channel\"[^,}]*' /app/appdata/default.json" 2>/dev/null || echo "<absent>")"
    fail "config did not record the channel (found: ${STORED}) -- is this image new enough to support it?"
fi

# --- check: the fetched binary matches that channel's latest upstream tag ---------
# Read the version from releases/latest, matching getLatestUpdateVersion in
# backend/youtube-dl.js. The tags API lists a tag as soon as it is pushed, which can be
# before the release that publishes the binary, so the two disagree during that window.
fetch_upstream_version() {
    local repo="$1"
    local version=""

    # Prefer gh when present: the unauthenticated API allows 60 requests/hour and repeated
    # runs of this script exhaust it quickly.
    if command -v gh >/dev/null 2>&1; then
        version="$(gh api "repos/${repo}/releases/latest" --jq '.tag_name' 2>/dev/null || true)"
    fi

    if [ -z "$version" ]; then
        version="$(curl -sS "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null \
            | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    fi

    printf '%s' "$version"
}

INSTALLED="$(run_as_runtime /app/appdata/bin/yt-dlp --version 2>/dev/null | tr -d '\r\n' || true)"
REPO="$(channel_repo "$CHANNEL")"
UPSTREAM="$(fetch_upstream_version "$REPO")"

info "installed=${INSTALLED:-<none>}  upstream ${CHANNEL}=${UPSTREAM:-<unreachable>}"
if [ -z "$UPSTREAM" ]; then
    info "skipping version comparison (GitHub tags API unreachable or rate-limited)"
elif [ "$INSTALLED" = "$UPSTREAM" ]; then
    pass "installed yt-dlp matches latest ${CHANNEL} (${INSTALLED})"
else
    fail "installed yt-dlp ${INSTALLED} != latest ${CHANNEL} ${UPSTREAM}"
fi

# --- optional: prove or disprove a reported download failure ----------------------
if [ "$DO_DOWNLOAD" -eq 1 ]; then
    echo
    info "attempting a real download: ${DOWNLOAD_URL}"
    DL_LOG="$(run_as_runtime /app/appdata/bin/yt-dlp --no-progress --no-part \
        -o '/tmp/repro.%(ext)s' "$DOWNLOAD_URL" 2>&1 || true)"
    if printf '%s' "$DL_LOG" | grep -q "HTTP Error 403"; then
        fail "download hit HTTP 403 on ${CHANNEL}"
        printf '%s\n' "$DL_LOG" | grep -iE 'player API|Downloading [0-9]+ format|ERROR' | sed 's/^/        /'
    elif printf '%s' "$DL_LOG" | grep -qiE '^ERROR|ERROR:'; then
        fail "download failed (not a 403)"
        printf '%s\n' "$DL_LOG" | tail -5 | sed 's/^/        /'
    else
        pass "download succeeded on ${CHANNEL}"
        printf '%s\n' "$DL_LOG" | grep -iE 'player API|Downloading [0-9]+ format|Merging' | sed 's/^/        /'
    fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "All checks passed."
else
    echo "${FAILURES} check(s) failed."
fi
exit "$FAILURES"
