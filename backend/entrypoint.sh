#!/bin/bash
set -eu

resolve_runtime_env() {
    local preferred_name="$1"
    local lowercase_legacy_name="$2"
    local uppercase_legacy_name="$3"
    local default_value="$4"
    local resolved_value=""

    resolved_value="$(printenv "$preferred_name" 2>/dev/null || true)"
    if [ -n "$resolved_value" ]; then
        printf '%s' "$resolved_value"
        return
    fi

    resolved_value="$(printenv "$lowercase_legacy_name" 2>/dev/null || true)"
    if [ -n "$resolved_value" ]; then
        printf '%s' "$resolved_value"
        return
    fi

    resolved_value="$(printenv "$uppercase_legacy_name" 2>/dev/null || true)"
    if [ -n "$resolved_value" ]; then
        printf '%s' "$resolved_value"
        return
    fi

    printf '%s' "$default_value"
}

runtime_uid="$(resolve_runtime_env ytdl_uid uid UID 1000)"
runtime_gid="$(resolve_runtime_env ytdl_gid gid GID 1000)"

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
