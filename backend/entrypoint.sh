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
