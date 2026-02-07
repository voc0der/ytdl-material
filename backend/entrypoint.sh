#!/bin/bash
set -eu

# Check if we're running as root
if [ "$(id -u)" = "0" ]; then
    # Running as root - fix permissions and drop privileges
    echo "[entrypoint] Running as root, fixing permissions (this may take a while)"
    find . \! -user "$UID" -exec chown "$UID:$GID" '{}' + || echo "WARNING! Could not change directory ownership. If you manage permissions externally this is fine, otherwise you may experience issues when downloading or deleting videos."
    exec gosu "$UID:$GID" "$@"
else
    # Already running as non-root user
    echo "[entrypoint] Running as non-root user (UID=$(id -u), GID=$(id -g))"
    exec "$@"
fi
