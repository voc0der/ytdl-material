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

runtime_uid="$(resolve_runtime_env 1000 ytdl_uid uid UID)"
runtime_gid="$(resolve_runtime_env 1000 ytdl_gid gid GID)"

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
