#!/bin/bash
set -eu

resolve_runtime_env() {
    local default_value="$1"
    shift
    local resolved_value=""
    local env_name

    for env_name in "$@"; do
        resolved_value="$(printenv "$env_name" 2>/dev/null || true)"
        if [ -n "$resolved_value" ]; then
            printf '%s' "$resolved_value"
            return
        fi
    done

    printf '%s' "$default_value"
}

is_truthy() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

python_target_has_ytdlp_impersonation() {
    python3 - "$1" <<'PY'
import importlib.util
import sys

sys.path.insert(0, sys.argv[1])
missing = [
    module
    for module in ("yt_dlp", "curl_cffi")
    if importlib.util.find_spec(module) is None
]
sys.exit(1 if missing else 0)
PY
}

# Impersonation mode runs `python3 -m yt_dlp` out of this pip target instead of the
# downloaded binary, so the yt-dlp update channel has to be honored here too. Otherwise the
# UI reports whatever channel the binary is on while downloads run stable PyPI yt-dlp.
resolve_ytdlp_update_channel() {
    local env_channel
    local env_name

    for env_name in ytdl_ytdlp_update_channel YTDL_YTDLP_UPDATE_CHANNEL; do
        if printenv "$env_name" >/dev/null 2>&1; then
            env_channel="$(printenv "$env_name")"
            printf '%s' "$env_channel" | tr '[:upper:]' '[:lower:]' | \
                sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
            return
        fi
    done

    if [ ! -r appdata/default.json ]; then
        return
    fi

    python3 -I - <<'PY'
import json
import sys
try:
    with open('appdata/default.json', encoding='utf-8') as config_file:
        config = json.load(config_file)
    if 'YtdlMaterial' in config:
        root = config.get('YtdlMaterial') or {}
    else:
        root = config.get('YoutubeDLMaterial') or {}
    channel = root.get('Advanced', {}).get('ytdlp_update_channel')
    if channel is not None:
        sys.stdout.write(str(channel).strip().lower())
except (AttributeError, OSError, TypeError, ValueError):
    # The backend will report malformed config with its normal startup diagnostics.
    pass
PY
}

install_ytdlp_impersonation_dependencies() {
    local enabled
    local target_path
    local channel
    local pip_pre_args
    local channel_marker
    local installed_channel

    enabled="$(resolve_runtime_env false \
        ytdl_enable_ytdlp_impersonation_dependencies \
        YTDL_ENABLE_YTDLP_IMPERSONATION_DEPENDENCIES \
        ytdl_enable_curl_cffi \
        YTDL_ENABLE_CURL_CFFI)"

    if ! is_truthy "$enabled"; then
        return
    fi

    target_path="$(resolve_runtime_env appdata/ytdlp-impersonation/python \
        ytdl_ytdlp_impersonation_python_path \
        YTDL_YTDLP_IMPERSONATION_PYTHON_PATH)"

    channel="$(resolve_ytdlp_update_channel)"
    [ -z "$channel" ] && channel="stable"

    case "$channel" in
        stable)
            pip_pre_args=""
            ;;
        nightly)
            pip_pre_args="--pre"
            ;;
        master)
            # PyPI only carries stable releases and nightly pre-releases; master builds are
            # published to GitHub only. Nightly is the closest available, and saying so is
            # better than silently running something the user did not pick.
            echo "[entrypoint] WARNING: PyPI has no 'master' channel for yt-dlp. Impersonation mode will use the nightly pre-release instead."
            pip_pre_args="--pre"
            ;;
        *)
            # Match the backend: an unrecognized channel is a config error, not a reason to
            # quietly install stable over a deliberately chosen newer build.
            echo "[entrypoint] ERROR: unknown ytdl_ytdlp_update_channel '${channel}'. Valid channels: stable, nightly, master. Skipping the impersonation dependency install and leaving any existing install untouched."
            return
            ;;
    esac

    # yt_dlp being importable is not enough to skip the install: switching channels has to
    # reinstall, and the module alone cannot tell us which channel produced it.
    channel_marker="${target_path}/.ytdl-material-channel"
    installed_channel="$(cat "$channel_marker" 2>/dev/null || true)"

    if python_target_has_ytdlp_impersonation "$target_path" && [ "$installed_channel" = "$channel" ]; then
        echo "[entrypoint] yt-dlp impersonation dependencies are already installed (channel: ${channel})"
        export PYTHONPATH="${target_path}${PYTHONPATH:+:${PYTHONPATH}}"
        return
    fi

    echo "[entrypoint] Installing optional yt-dlp impersonation dependencies (channel: ${channel})"
    mkdir -p "$target_path"
    # shellcheck disable=SC2086 # pip_pre_args is intentionally unquoted: empty or --pre
    python3 -m pip install --upgrade $pip_pre_args --target "$target_path" "yt-dlp[default,curl-cffi]" yt-dlp-ejs

    if ! python_target_has_ytdlp_impersonation "$target_path"; then
        echo "[entrypoint] ERROR: yt-dlp impersonation dependencies were not available after installation."
        exit 1
    fi

    printf '%s' "$channel" > "$channel_marker" 2>/dev/null || true
    export PYTHONPATH="${target_path}${PYTHONPATH:+:${PYTHONPATH}}"
}

resolve_transcoding_mode() {
    local env_mode
    local env_name

    for env_name in ytdl_transcoding YTDL_TRANSCODING; do
        if printenv "$env_name" >/dev/null 2>&1; then
            env_mode="$(printenv "$env_name")"
            printf '%s' "$env_mode" | tr '[:upper:]' '[:lower:]' | \
                sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
            return
        fi
    done

    if [ ! -r appdata/default.json ]; then
        return
    fi

    python3 -I - <<'PY'
import json
import sys
try:
    with open('appdata/default.json', encoding='utf-8') as config_file:
        config = json.load(config_file)
    if 'YtdlMaterial' in config:
        root = config.get('YtdlMaterial') or {}
    else:
        root = config.get('YoutubeDLMaterial') or {}
    mode = root.get('Downloader', {}).get('transcoding')
    if mode is not None:
        sys.stdout.write(str(mode).strip().lower())
except (AttributeError, OSError, TypeError, ValueError):
    # The backend will report malformed config with its normal startup diagnostics.
    pass
PY
}

package_is_installed() {
    dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

transcoding_runtime_is_installed() {
    local transcoding_mode="$1"

    package_is_installed libva-drm2 || return 1

    case "$transcoding_mode" in
        qsv|intel|quicksync)
            ls /usr/lib/*/dri/iHD_drv_video.so >/dev/null 2>&1 || return 1
            package_is_installed libmfx-gen1.2 || return 1
            ;;
        *)
            ls /usr/lib/*/dri/*_drv_video.so >/dev/null 2>&1 || return 1
            ;;
    esac
}

install_transcoding_drivers() {
    local transcoding_mode="$1"

    # Only VAAPI/QSV need userspace drivers inside the container.
    # NVENC (libcuda) and AMF (libamfrt) runtimes come from the host via the container runtime.
    case "$transcoding_mode" in
        vaapi|qsv|intel|quicksync)
            ;;
        *)
            return
            ;;
    esac

    # Skip only when the complete mode-specific runtime is present from a previous
    # start or a derived image. A VA driver alone cannot open /dev/dri devices.
    if transcoding_runtime_is_installed "$transcoding_mode"; then
        echo "[entrypoint] VAAPI/QSV userspace drivers are already installed"
        return
    fi

    if [ "$(id -u)" != "0" ]; then
        echo "[entrypoint] WARNING: ytdl_transcoding is set to '$transcoding_mode' but the container is not running as root, so VAAPI/QSV drivers cannot be installed automatically. Hardware acceleration will likely fail its flight test."
        return
    fi

    echo "[entrypoint] Installing VAAPI/QSV userspace drivers for ytdl_transcoding='$transcoding_mode'"
    export DEBIAN_FRONTEND=noninteractive
    if ! apt-get update; then
        echo "[entrypoint] WARNING: apt-get update failed; hardware acceleration drivers were not installed."
        return
    fi
    apt-get install -y --no-install-recommends libva-drm2 || echo "[entrypoint] WARNING: libva-drm2 could not be installed"
    apt-get install -y --no-install-recommends mesa-va-drivers || echo "[entrypoint] WARNING: mesa-va-drivers could not be installed"
    apt-get install -y --no-install-recommends intel-media-va-driver-non-free || \
        apt-get install -y --no-install-recommends intel-media-va-driver || \
        echo "[entrypoint] WARNING: intel-media-va-driver could not be installed"
    case "$transcoding_mode" in
        qsv|intel|quicksync)
            apt-get install -y --no-install-recommends libmfx-gen1.2 || echo "[entrypoint] WARNING: libmfx-gen1.2 could not be installed"
            ;;
    esac
    rm -rf /var/lib/apt/lists/*
}

resolve_runtime_home() {
    local passwd_name
    local passwd_uid
    local passwd_home

    while IFS=: read -r passwd_name _ passwd_uid _ _ passwd_home _; do
        if [ "$passwd_name" = "$1" ] || [ "$passwd_uid" = "$1" ]; then
            printf '%s' "${passwd_home:-/}"
            return
        fi
    done < /etc/passwd

    printf '/'
}

has_supplementary_groups() {
    local primary_gid
    local group_gid
    local group_ids

    primary_gid="$(id -g)"
    group_ids="$(id -G 2>/dev/null || true)"
    for group_gid in $group_ids; do
        if [ "$group_gid" != "$primary_gid" ]; then
            return 0
        fi
    done

    return 1
}

runtime_uid="$(resolve_runtime_env 1000 ytdl_uid uid UID)"
runtime_gid="$(resolve_runtime_env 1000 ytdl_gid gid GID)"
transcoding_mode="$(resolve_transcoding_mode)"

install_ytdlp_impersonation_dependencies
install_transcoding_drivers "$transcoding_mode"

# Check if we're running as root
if [ "$(id -u)" = "0" ]; then
    # Running as root - fix permissions and drop privileges
    echo "[entrypoint] Running as root, fixing permissions (this may take a while)"
    find . \! -user "$runtime_uid" -exec chown "$runtime_uid:$runtime_gid" '{}' + || echo "WARNING! Could not change directory ownership. If you manage permissions externally this is fine, otherwise you may experience issues when downloading or deleting videos."
    case "$transcoding_mode" in
        vaapi|qsv|intel|quicksync)
            if has_supplementary_groups; then
                # Docker's group_add values exist in the process' supplementary group
                # list, not necessarily in /etc/group. Preserve that kernel-level list
                # for DRI access while matching gosu's HOME resolution behavior.
                HOME="$(resolve_runtime_home "$runtime_uid")"
                export HOME
                exec setpriv --reuid "$runtime_uid" --regid "$runtime_gid" --keep-groups -- "$@"
            fi
            ;;
    esac

    # Keep the established privilege-drop behavior outside the DRI group_add case.
    exec gosu "$runtime_uid:$runtime_gid" "$@"
else
    # Already running as non-root user
    echo "[entrypoint] Running as non-root user (UID=$(id -u), GID=$(id -g))"
    exec "$@"
fi
