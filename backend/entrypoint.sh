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

install_ytdlp_impersonation_dependencies() {
    local enabled
    local target_path

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

    if python_target_has_ytdlp_impersonation "$target_path"; then
        echo "[entrypoint] yt-dlp impersonation dependencies are already installed"
        export PYTHONPATH="${target_path}${PYTHONPATH:+:${PYTHONPATH}}"
        return
    fi

    echo "[entrypoint] Installing optional yt-dlp impersonation dependencies"
    mkdir -p "$target_path"
    python3 -m pip install --upgrade --target "$target_path" "yt-dlp[default,curl-cffi]" yt-dlp-ejs

    if ! python_target_has_ytdlp_impersonation "$target_path"; then
        echo "[entrypoint] ERROR: yt-dlp impersonation dependencies were not available after installation."
        exit 1
    fi

    export PYTHONPATH="${target_path}${PYTHONPATH:+:${PYTHONPATH}}"
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

    # Skip if both the DRM bridge and a VA driver are already present (from a previous
    # start or a derived image). A driver alone cannot open /dev/dri devices.
    if dpkg-query -W -f='${Status}' libva-drm2 2>/dev/null | grep -q 'ok installed' && \
        ls /usr/lib/*/dri/*_drv_video.so >/dev/null 2>&1; then
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

runtime_uid="$(resolve_runtime_env 1000 ytdl_uid uid UID)"
runtime_gid="$(resolve_runtime_env 1000 ytdl_gid gid GID)"
transcoding_mode="$(resolve_runtime_env "" ytdl_transcoding YTDL_TRANSCODING | tr '[:upper:]' '[:lower:]')"

install_ytdlp_impersonation_dependencies
install_transcoding_drivers "$transcoding_mode"

# Check if we're running as root
if [ "$(id -u)" = "0" ]; then
    # Running as root - fix permissions and drop privileges
    echo "[entrypoint] Running as root, fixing permissions (this may take a while)"
    find . \! -user "$runtime_uid" -exec chown "$runtime_uid:$runtime_gid" '{}' + || echo "WARNING! Could not change directory ownership. If you manage permissions externally this is fine, otherwise you may experience issues when downloading or deleting videos."
    case "$transcoding_mode" in
        vaapi|qsv|intel|quicksync)
            # Docker's group_add values exist in the process' supplementary group list,
            # not necessarily in /etc/group. Preserve that kernel-level list for DRI
            # access while matching gosu's HOME resolution behavior.
            export HOME="$(resolve_runtime_home "$runtime_uid")"
            exec setpriv --reuid "$runtime_uid" --regid "$runtime_gid" --keep-groups -- "$@"
            ;;
        *)
            # Keep the established privilege-drop behavior for every other configuration.
            exec gosu "$runtime_uid:$runtime_gid" "$@"
            ;;
    esac
else
    # Already running as non-root user
    echo "[entrypoint] Running as non-root user (UID=$(id -u), GID=$(id -g))"
    exec "$@"
fi
