# shellcheck shell=bash
# ---------------------------------------------------------------------------
# ops/lib/common.sh — shared helpers for GIX localnet ops scripts.
#
# Sourced by every ops/scripts/*.sh. Provides: logging, prerequisite checks,
# path resolution, JSON helpers, and the localnet RPC/faucet endpoints.
#
# This file is meant to be *sourced*, not executed. It sets `set -euo pipefail`
# in the sourcing script's context only if GIX_STRICT is unset (callers may opt
# out). Keep it POSIX-bash; targets bash 4+, which Node 18 / sui 1.73 hosts have.
# ---------------------------------------------------------------------------

# --- Resolve repo layout (independent of caller's CWD) ----------------------
# common.sh lives at <repo>/ops/lib/common.sh
GIX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIX_OPS_DIR="$(cd "${GIX_LIB_DIR}/.." && pwd)"
GIX_ROOT="$(cd "${GIX_OPS_DIR}/.." && pwd)"
export GIX_LIB_DIR GIX_OPS_DIR GIX_ROOT

GIX_CONTRACTS_DIR="${GIX_ROOT}/contracts"
GIX_HARNESS_DIR="${GIX_ROOT}/harness"
GIX_EXAMPLES_DIR="${GIX_ROOT}/examples"
export GIX_CONTRACTS_DIR GIX_HARNESS_DIR GIX_EXAMPLES_DIR

# Canonical artifact locations. The integration contract says A emits
# deployment.json "at repo root or ops/"; we look in both, prefer repo root.
GIX_DEPLOYMENT_JSON="${GIX_DEPLOYMENT_JSON:-${GIX_ROOT}/deployment.json}"
export GIX_DEPLOYMENT_JSON

# Where we persist ops state (PIDs, logs) — gitignore-friendly scratch dir.
GIX_RUN_DIR="${GIX_RUN_DIR:-${GIX_OPS_DIR}/.run}"
export GIX_RUN_DIR

# --- Localnet endpoints -----------------------------------------------------
# `sui start --with-faucet` defaults: RPC 9000, faucet 9123.
GIX_LOCALNET_RPC="${GIX_LOCALNET_RPC:-http://127.0.0.1:9000}"
GIX_LOCALNET_FAUCET="${GIX_LOCALNET_FAUCET:-http://127.0.0.1:9123/gas}"
GIX_LOCALNET_ENV_ALIAS="${GIX_LOCALNET_ENV_ALIAS:-localnet}"
export GIX_LOCALNET_RPC GIX_LOCALNET_FAUCET GIX_LOCALNET_ENV_ALIAS

# Gas budgets (MIST). Generous for localnet; localnet gas is free.
GIX_PUBLISH_GAS_BUDGET="${GIX_PUBLISH_GAS_BUDGET:-2000000000}"
GIX_CALL_GAS_BUDGET="${GIX_CALL_GAS_BUDGET:-200000000}"
export GIX_PUBLISH_GAS_BUDGET GIX_CALL_GAS_BUDGET

# --- Colors / logging -------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _c_red=$'\033[31m'; _c_grn=$'\033[32m'; _c_yel=$'\033[33m'
  _c_blu=$'\033[34m'; _c_dim=$'\033[2m'; _c_rst=$'\033[0m'
else
  _c_red=''; _c_grn=''; _c_yel=''; _c_blu=''; _c_dim=''; _c_rst=''
fi

log()   { printf '%s[gix]%s %s\n' "${_c_blu}" "${_c_rst}" "$*" >&2; }
ok()    { printf '%s[gix] ✓%s %s\n' "${_c_grn}" "${_c_rst}" "$*" >&2; }
warn()  { printf '%s[gix] !%s %s\n' "${_c_yel}" "${_c_rst}" "$*" >&2; }
err()   { printf '%s[gix] ✗%s %s\n' "${_c_red}" "${_c_rst}" "$*" >&2; }
dim()   { printf '%s%s%s\n' "${_c_dim}" "$*" "${_c_rst}" >&2; }
die()   { err "$*"; exit 1; }

# --- Prerequisite checks ----------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  # require_cmd <bin> [hint]
  local bin="$1" hint="${2:-}"
  if ! have "$bin"; then
    err "required command not found: ${bin}"
    [ -n "$hint" ] && dim "      hint: ${hint}"
    return 1
  fi
}

# Asserts the toolchain ops needs. jq is required for JSON parsing in pure bash.
require_base_tools() {
  local missing=0
  require_cmd sui "install Sui 1.x — https://docs.sui.io/guides/developer/getting-started/sui-install" || missing=1
  require_cmd jq  "install jq — e.g. 'apt-get install jq' or 'brew install jq'" || missing=1
  require_cmd curl "install curl" || missing=1
  [ "$missing" -eq 0 ] || die "missing prerequisites (see above)"
  ok "base tools present: sui $(sui --version 2>/dev/null | awk '{print $2}'), jq, curl"
}

require_node() {
  require_cmd node "install Node 18+ — https://nodejs.org" || die "node required"
  require_cmd npm  "npm ships with Node" || die "npm required"
  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "${major:-0}" -lt 18 ]; then
    warn "Node ${major} detected; harness targets Node 18+. Continuing anyway."
  fi
}

# --- Localnet liveness ------------------------------------------------------
# Returns 0 if a JSON-RPC fullnode answers on the localnet RPC port.
localnet_is_up() {
  curl -s -m 3 -X POST "${GIX_LOCALNET_RPC}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}' \
    2>/dev/null | grep -q '"result"'
}

faucet_is_up() {
  # The faucet has no health route in all versions; a HEAD/GET to the base
  # returning any HTTP response is enough to know the port is bound.
  local base="${GIX_LOCALNET_FAUCET%/gas}"
  curl -s -m 3 -o /dev/null -w '%{http_code}' "${base}/" 2>/dev/null | grep -qE '^[0-9]{3}$'
}

# Block until localnet RPC responds, or fail after <timeout> seconds.
wait_for_localnet() {
  local timeout="${1:-60}" waited=0
  log "waiting for localnet RPC at ${GIX_LOCALNET_RPC} (timeout ${timeout}s)..."
  while [ "$waited" -lt "$timeout" ]; do
    if localnet_is_up; then ok "localnet RPC is live"; return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  err "localnet did not come up within ${timeout}s"
  return 1
}

# --- sui client env wiring --------------------------------------------------
# Ensure a `localnet` env alias exists and is active, pointing at our RPC.
ensure_localnet_env() {
  if sui client envs --json 2>/dev/null | jq -e \
       --arg a "${GIX_LOCALNET_ENV_ALIAS}" '.[]? | select(.[0]==$a or .alias==$a)' >/dev/null 2>&1; then
    :
  elif sui client envs 2>/dev/null | grep -qw "${GIX_LOCALNET_ENV_ALIAS}"; then
    :
  else
    log "creating sui client env '${GIX_LOCALNET_ENV_ALIAS}' -> ${GIX_LOCALNET_RPC}"
    sui client new-env --alias "${GIX_LOCALNET_ENV_ALIAS}" --rpc "${GIX_LOCALNET_RPC}" >/dev/null 2>&1 \
      || warn "could not create env alias (may already exist)"
  fi
  sui client switch --env "${GIX_LOCALNET_ENV_ALIAS}" >/dev/null 2>&1 \
    || warn "could not switch to env '${GIX_LOCALNET_ENV_ALIAS}'"
}

active_address() { sui client active-address 2>/dev/null; }

# --- deployment.json discovery & access -------------------------------------
# Locate deployment.json: env override > repo root > ops/.
find_deployment_json() {
  for cand in "${GIX_DEPLOYMENT_JSON}" "${GIX_ROOT}/deployment.json" "${GIX_OPS_DIR}/deployment.json"; do
    [ -f "$cand" ] && { printf '%s\n' "$cand"; return 0; }
  done
  return 1
}

# Read a jq path out of deployment.json. Usage: deployment_get '.packageId'
deployment_get() {
  local path="$1" f
  f="$(find_deployment_json)" || { err "deployment.json not found (run 'make deploy' first)"; return 1; }
  jq -er "$path" "$f"
}

# Validate that deployment.json matches the integration-contract schema enough
# for downstream tools to use it. Returns 0/1 and logs what's missing.
validate_deployment_json() {
  local f
  f="$(find_deployment_json)" || { err "deployment.json not found"; return 1; }
  if ! jq -e . "$f" >/dev/null 2>&1; then
    err "deployment.json is not valid JSON: $f"; return 1
  fi
  local missing=()
  for key in network packageId configId adminCapId usdcType clockId markets accounts; do
    jq -e "has(\"$key\")" "$f" >/dev/null 2>&1 || missing+=("$key")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    err "deployment.json missing required keys: ${missing[*]}"
    dim "      expected schema: docs/mvp-m1-integration-contract.md §'A → C/B'"
    return 1
  fi
  ok "deployment.json valid: $f"
  return 0
}

mkrundir() { mkdir -p "${GIX_RUN_DIR}"; }
