#!/usr/bin/env bash
#
# Throwaway OpenLDAP server for exercising the LDAP auth path locally.
#
# Nothing in CI uses this, and nothing it touches lives inside the repo: the source
# tarball, the build and the directory data all sit under the cache dir printed by
# `ldap-server.sh env`. Deleting that directory undoes everything this script does.
#
# Usage: dev/ldap/ldap-server.sh <command>
# Run with no arguments for the command list.

set -euo pipefail

OPENLDAP_VERSION="${OPENLDAP_VERSION:-2.6.14}"
# Published alongside the tarball as openldap-<version>.sha3-512. Pinned here rather
# than fetched so a swapped tarball fails the build instead of bringing its own digest.
OPENLDAP_SHA3_512="${OPENLDAP_SHA3_512:-ac6a9de179d89ae498b74da4127699ea0963cd98e750c9cf81e11d71610c5dd07fee3b42c6b82ed23561797294b33f475189bbb86f0aa865453cc4158104b024}"
OPENLDAP_URL="https://www.openldap.org/software/download/OpenLDAP/openldap-release/openldap-${OPENLDAP_VERSION}.tgz"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/fixtures"

CACHE_ROOT="${YTDL_LDAP_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ytdl-material/openldap}"
PREFIX="$CACHE_ROOT/$OPENLDAP_VERSION"
BUILD_DIR="$CACHE_ROOT/build"
TARBALL="$CACHE_ROOT/openldap-${OPENLDAP_VERSION}.tgz"
RUN_DIR="${YTDL_LDAP_RUN_DIR:-$CACHE_ROOT/run}"
DATA_DIR="$RUN_DIR/data"
CONF="$RUN_DIR/slapd.conf"
# slapd writes this itself, per the pidfile directive in slapd.conf.tmpl. Tracking the
# shell's $! separately would just give us a second copy to keep in sync.
PID_FILE="$RUN_DIR/slapd.pid"
LOG_FILE="$RUN_DIR/slapd.log"

HOST="${YTDL_LDAP_HOST:-127.0.0.1}"
PORT="${YTDL_LDAP_PORT:-3389}"
URL="ldap://$HOST:$PORT"

SUFFIX="dc=ytdl,dc=test"
ROOT_DN="cn=admin,$SUFFIX"
ROOT_PW="ytdl-test-admin"
SEARCH_BASE="ou=people,$SUFFIX"

SLAPD="$PREFIX/libexec/slapd"
SLAPADD="$PREFIX/sbin/slapadd"
LDAPSEARCH="$PREFIX/bin/ldapsearch"

say() { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[0;31m==>\033[0m %s\n' "$*" >&2; exit 1; }

require_tools() {
  local missing=()
  for tool in curl tar make gcc openssl; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing build tools: ${missing[*]}"
}

is_built() { [ -x "$SLAPD" ] && [ -x "$SLAPADD" ] && [ -x "$LDAPSEARCH" ]; }

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

download() {
  mkdir -p "$CACHE_ROOT"
  if [ ! -f "$TARBALL" ]; then
    say "downloading openldap $OPENLDAP_VERSION"
    curl -fL --retry 3 --connect-timeout 10 -o "$TARBALL.part" "$OPENLDAP_URL"
    mv "$TARBALL.part" "$TARBALL"
  fi
  local actual
  actual="$(openssl dgst -sha3-512 "$TARBALL" | awk '{print $NF}')"
  if [ "$actual" != "$OPENLDAP_SHA3_512" ]; then
    rm -f "$TARBALL"
    die "checksum mismatch for openldap-$OPENLDAP_VERSION.tgz (got $actual); deleted the download. If you set OPENLDAP_VERSION, set OPENLDAP_SHA3_512 to match."
  fi
  say "checksum ok"
}

cmd_build() {
  if is_built && [ "${1:-}" != "--force" ]; then
    say "already built at $PREFIX (pass --force to rebuild)"
    return 0
  fi
  require_tools
  download
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  say "extracting"
  tar xzf "$TARBALL" -C "$BUILD_DIR"
  local src="$BUILD_DIR/openldap-$OPENLDAP_VERSION"
  say "configuring (this takes a minute)"
  (
    cd "$src"
    # No SASL and no modules: a static slapd with the mdb backend is all the auth path
    # needs, and every dependency skipped here is one less thing to install first.
    ./configure \
      --prefix="$PREFIX" \
      --without-cyrus-sasl \
      --with-tls=openssl \
      --enable-slapd \
      --enable-mdb \
      --disable-relay \
      --without-systemd \
      > "$CACHE_ROOT/configure.log" 2>&1 || { tail -30 "$CACHE_ROOT/configure.log" >&2; die "configure failed (full log: $CACHE_ROOT/configure.log)"; }
    say "building"
    make depend > "$CACHE_ROOT/build.log" 2>&1
    # OpenLDAP's makefiles are not reliably parallel-safe; retry serially before giving up.
    make -j"$(nproc)" >> "$CACHE_ROOT/build.log" 2>&1 || make >> "$CACHE_ROOT/build.log" 2>&1 \
      || { tail -30 "$CACHE_ROOT/build.log" >&2; die "build failed (full log: $CACHE_ROOT/build.log)"; }
    say "installing into $PREFIX"
    # systemdsystemunitdir defaults to /usr/lib/systemd/system, which install writes to
    # even under --prefix -- and which is not writable (nor wanted) for a throwaway
    # build. Blanking it makes the Makefile skip the unit file entirely.
    make install systemdsystemunitdir= >> "$CACHE_ROOT/build.log" 2>&1
  )
  rm -rf "$BUILD_DIR"
  is_built || die "build finished but slapd is missing from $PREFIX"
  say "built openldap $OPENLDAP_VERSION"
}

write_conf() {
  mkdir -p "$RUN_DIR" "$DATA_DIR"
  sed \
    -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@RUN_DIR@|$RUN_DIR|g" \
    -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@SUFFIX@|$SUFFIX|g" \
    -e "s|@ROOT_DN@|$ROOT_DN|g" \
    -e "s|@ROOT_PW@|$ROOT_PW|g" \
    "$FIXTURES/slapd.conf.tmpl" > "$CONF"
}

wait_until_ready() {
  local attempt=0
  while [ "$attempt" -lt 50 ]; do
    if "$LDAPSEARCH" -x -H "$URL" -b "" -s base -LLL namingContexts > /dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.2
  done
  warn "slapd did not answer within 10s; last log lines:"
  tail -20 "$LOG_FILE" >&2 || true
  return 1
}

cmd_start() {
  is_built || cmd_build
  if running_pid > /dev/null; then
    say "already running on $URL (pid $(running_pid))"
    return 0
  fi
  # A stale socket from a crashed run is the usual cause of a confusing bind failure.
  if "$LDAPSEARCH" -x -H "$URL" -b "" -s base -LLL namingContexts > /dev/null 2>&1; then
    die "something is already listening on $PORT that this script did not start"
  fi
  say "seeding a fresh directory"
  rm -rf "$RUN_DIR"
  write_conf
  "$SLAPADD" -q -f "$CONF" -l "$FIXTURES/seed.ldif" > "$RUN_DIR/slapadd.log" 2>&1 \
    || { cat "$RUN_DIR/slapadd.log" >&2; die "slapadd failed"; }
  say "starting slapd on $URL"
  # -d 256 (stats) keeps slapd in the foreground so the log lands in a file we control
  # instead of the system journal, which a non-root dev process cannot write to anyway.
  nohup "$SLAPD" -f "$CONF" -h "$URL/" -d 256 > "$LOG_FILE" 2>&1 &
  wait_until_ready || { cmd_stop; die "slapd failed to start"; }
  say "ready"
  cmd_env
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    say "not running"
    # Covers the case where slapd outlived its pidfile -- otherwise the next `start`
    # dies on the port being taken with no hint as to what is holding it.
    if "$LDAPSEARCH" -x -H "$URL" -b "" -s base -LLL namingContexts > /dev/null 2>&1; then
      warn "but $PORT is still answering LDAP; find the stray slapd with: ss -ltnp | grep $PORT"
    fi
    rm -f "$PID_FILE"
    return 0
  fi
  say "stopping slapd (pid $pid)"
  kill "$pid" 2>/dev/null || true
  local attempt=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 50 ]; do
    attempt=$((attempt + 1))
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_status() {
  if running_pid > /dev/null; then
    say "running on $URL (pid $(running_pid))"
    "$LDAPSEARCH" -x -H "$URL" -D "$ROOT_DN" -w "$ROOT_PW" -b "$SEARCH_BASE" -LLL uid || true
  else
    say "not running"
    is_built && say "built at $PREFIX" || say "not built"
  fi
}

cmd_search() {
  running_pid > /dev/null || die "not running; start it first"
  "$LDAPSEARCH" -x -H "$URL" -D "$ROOT_DN" -w "$ROOT_PW" -b "$SUFFIX" "${@:-(objectClass=*)}"
}

cmd_env() {
  cat <<ENV
YTDL_TEST_LDAP_URL=$URL
YTDL_TEST_LDAP_BIND_DN=$ROOT_DN
YTDL_TEST_LDAP_BIND_PW=$ROOT_PW
YTDL_TEST_LDAP_SEARCH_BASE=$SEARCH_BASE
ENV
}

cmd_clean() {
  cmd_stop
  say "removing $RUN_DIR"
  rm -rf "$RUN_DIR"
  if [ "${1:-}" = "--all" ]; then
    say "removing $CACHE_ROOT"
    rm -rf "$CACHE_ROOT"
  fi
}

cmd_help() {
  cat <<'HELP'
dev/ldap/ldap-server.sh <command>

  build [--force]  download, verify and compile OpenLDAP into the cache dir
  start            (re)seed the directory and start slapd on 127.0.0.1:3389
  stop             stop slapd
  restart          stop, reseed, start
  status           show whether it is running, and list the seeded uids
  search [filter]  run ldapsearch against it as the admin account
  env              print the YTDL_TEST_LDAP_* vars the backend tests read
  clean [--all]    stop and drop the directory data (--all drops the build too)

The backend LDAP tests skip themselves when nothing is listening, so `start` is the
only thing that has to happen before `npm test` in backend/ exercises them:

  dev/ldap/ldap-server.sh start
  cd backend && npm test
HELP
}

case "${1:-help}" in
  build)   shift; cmd_build "$@";;
  start)   shift; cmd_start "$@";;
  stop)    shift; cmd_stop "$@";;
  restart) shift; cmd_restart "$@";;
  status)  shift; cmd_status "$@";;
  search)  shift; cmd_search "$@";;
  env)     shift; cmd_env "$@";;
  clean)   shift; cmd_clean "$@";;
  help|-h|--help) cmd_help;;
  *) warn "unknown command: $1"; cmd_help; exit 1;;
esac
