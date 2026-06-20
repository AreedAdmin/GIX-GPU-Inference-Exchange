#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ops/scripts/localnet.sh — start / stop / reset / status a Sui localnet.
#
# Targets sui 1.73 where the localnet command is `sui start` (the old
# `sui-test-validator` binary is gone). We run an ephemeral, reset-every-run
# network with a built-in faucet:
#
#     sui start --force-regenesis --with-faucet
#
# --force-regenesis  → fresh genesis every boot, no persisted db (matches the
#                      "wiped freely" localnet promise in operations/deployment.md §1).
# --with-faucet      → faucet on 0.0.0.0:9123 so we can fund test accounts.
#
# The validator is long-running, so `start` launches it in the background and
# records the PID. `stop` kills it. `reset` = stop + start (state is ephemeral
# anyway, so a restart is a full wipe).
#
# Usage:
#   localnet.sh start   [--foreground] [--timeout N]
#   localnet.sh stop
#   localnet.sh reset
#   localnet.sh status
# ---------------------------------------------------------------------------
set -euo pipefail
# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

PIDFILE="${GIX_RUN_DIR}/localnet.pid"
LOGFILE="${GIX_RUN_DIR}/localnet.log"

# Detect whether this sui build supports `sui start` at all. If not, we degrade
# gracefully and tell the operator to start localnet by hand.
detect_localnet_support() {
  if sui start --help >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

print_manual_instructions() {
  cat >&2 <<EOF
${_c_yel}This 'sui' build does not expose 'sui start'.${_c_rst}
Start a localnet manually with whatever your toolchain provides, e.g.:
    sui-test-validator                       # older toolchains
    RUST_LOG=off sui start --with-faucet     # newer toolchains
Then ensure RPC is reachable at ${GIX_LOCALNET_RPC} and the faucet at
${GIX_LOCALNET_FAUCET}, and re-run 'make deploy'.
EOF
}

cmd_start() {
  local foreground=0 timeout=90
  while [ $# -gt 0 ]; do
    case "$1" in
      --foreground|-f) foreground=1 ;;
      --timeout) shift; timeout="${1:-90}" ;;
      *) warn "unknown arg to start: $1" ;;
    esac
    shift
  done

  require_base_tools
  mkrundir
  ensure_localnet_env || true

  if localnet_is_up; then
    ok "localnet already running at ${GIX_LOCALNET_RPC}"
    return 0
  fi

  if ! detect_localnet_support; then
    err "cannot auto-start localnet with this sui build."
    print_manual_instructions
    return 1
  fi

  # RUST_LOG=off keeps the background log quiet; override via env if debugging.
  local rust_log="${RUST_LOG:-off}"

  if [ "$foreground" -eq 1 ]; then
    log "starting localnet in foreground (Ctrl-C to stop)..."
    exec env RUST_LOG="${rust_log}" sui start --force-regenesis --with-faucet
  fi

  log "starting localnet (background): sui start --force-regenesis --with-faucet"
  dim "      logs: ${LOGFILE}"
  # nohup + disown so it survives this shell; capture PID.
  nohup env RUST_LOG="${rust_log}" sui start --force-regenesis --with-faucet \
    >"${LOGFILE}" 2>&1 &
  echo $! >"${PIDFILE}"
  disown || true

  if wait_for_localnet "${timeout}"; then
    ensure_localnet_env || true
    ok "localnet up (pid $(cat "${PIDFILE}")). RPC ${GIX_LOCALNET_RPC}, faucet ${GIX_LOCALNET_FAUCET}"
  else
    err "localnet failed to start; tail of ${LOGFILE}:"
    tail -n 20 "${LOGFILE}" >&2 || true
    return 1
  fi
}

cmd_stop() {
  local stopped=0
  if [ -f "${PIDFILE}" ]; then
    local pid; pid="$(cat "${PIDFILE}")"
    if kill -0 "${pid}" 2>/dev/null; then
      log "stopping localnet (pid ${pid})..."
      kill "${pid}" 2>/dev/null || true
      # give it a moment, then SIGKILL if needed
      for _ in 1 2 3 4 5; do kill -0 "${pid}" 2>/dev/null || break; sleep 1; done
      kill -9 "${pid}" 2>/dev/null || true
      stopped=1
    fi
    rm -f "${PIDFILE}"
  fi
  # Fallback: kill any stray `sui start` we own.
  if pgrep -f 'sui start' >/dev/null 2>&1; then
    log "killing stray 'sui start' processes..."
    pkill -f 'sui start' 2>/dev/null || true
    stopped=1
  fi
  if [ "$stopped" -eq 1 ]; then ok "localnet stopped"; else warn "no running localnet found"; fi
}

cmd_reset() {
  log "resetting localnet (stop + fresh regenesis start)..."
  cmd_stop || true
  sleep 1
  cmd_start "$@"
}

cmd_status() {
  if localnet_is_up; then
    ok "localnet RPC is UP at ${GIX_LOCALNET_RPC}"
    if faucet_is_up; then ok "faucet is UP at ${GIX_LOCALNET_FAUCET}"; else warn "faucet not reachable at ${GIX_LOCALNET_FAUCET}"; fi
    [ -f "${PIDFILE}" ] && dim "      pid: $(cat "${PIDFILE}")"
    sui client active-env >/dev/null 2>&1 && dim "      active env: $(sui client active-env 2>/dev/null)"
  else
    warn "localnet RPC is DOWN at ${GIX_LOCALNET_RPC}"
    return 1
  fi
}

main() {
  local sub="${1:-status}"; shift || true
  case "$sub" in
    start)  cmd_start "$@" ;;
    stop)   cmd_stop "$@" ;;
    reset)  cmd_reset "$@" ;;
    status) cmd_status "$@" ;;
    *) die "usage: localnet.sh {start|stop|reset|status} [opts]" ;;
  esac
}
main "$@"
