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

python_module_available() {
    python3 - "$1" <<'PY'
import importlib.util
import sys

sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)
PY
}

install_ytdlp_impersonation_dependencies() {
    local enabled
    enabled="$(resolve_runtime_env false \
        ytdl_enable_ytdlp_impersonation_dependencies \
        YTDL_ENABLE_YTDLP_IMPERSONATION_DEPENDENCIES \
        ytdl_enable_curl_cffi \
        YTDL_ENABLE_CURL_CFFI)"

    if ! is_truthy "$enabled"; then
        return
    fi

    if python_module_available curl_cffi; then
        echo "[entrypoint] yt-dlp impersonation dependency curl_cffi is already installed"
        return
    fi

    if [ "$(id -u)" != "0" ]; then
        echo "[entrypoint] ERROR: ytdl_enable_ytdlp_impersonation_dependencies is enabled,"
        echo "[entrypoint] but curl_cffi is missing and the container is not running as root."
        echo "[entrypoint] Start as root for the entrypoint install step, or bake curl_cffi into a custom image."
        exit 1
    fi

    echo "[entrypoint] Installing optional yt-dlp impersonation dependencies"
    python3 -m pip install --upgrade --break-system-packages "yt-dlp[default,curl-cffi]" yt-dlp-ejs || \
        python3 -m pip install --upgrade "yt-dlp[default,curl-cffi]" yt-dlp-ejs

    if ! python_module_available curl_cffi; then
        echo "[entrypoint] ERROR: curl_cffi was not available after installation."
        exit 1
    fi
}

runtime_uid="$(resolve_runtime_env 1000 ytdl_uid uid UID)"
runtime_gid="$(resolve_runtime_env 1000 ytdl_gid gid GID)"

install_ytdlp_impersonation_dependencies

# Check if we're running as root
if [ "$(id -u)" = "0" ]; then
    # Running as root - fix permissions and drop privileges
    echo "[entrypoint] Running as root, fixing permissions (this may take a while)"
    find . \! -user "$runtime_uid" -exec chown "$runtime_uid:$runtime_gid" '{}' + || echo "WARNING! Could not change directory ownership. If you manage permissions externally this is fine, otherwise you may experience issues when downloading or deleting videos."
    exec gosu "$runtime_uid:$runtime_gid" "$@"
else
    # Already running as non-root user
    echo "[entrypoint] Running as non-root user (UID=$(id -u), GID=$(id -g))"
    exec "$@"
fi
