#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ops/scripts/deploy.sh — publish the `gix` package to localnet and ensure a
# valid deployment.json exists for the harness (workstream B) and ops to use.
#
# DIVISION OF LABOR (per docs/mvp-m1-integration-contract.md):
#   • Workstream A (contracts/) OWNS the deploy script and is the source of
#     truth for `deployment.json`. If A ships a deploy script, we DELEGATE to it.
#   • This wrapper's job is orchestration: preflight, locate/run A's script,
#     then validate the emitted deployment.json against the binding schema.
#
# A's deploy script is auto-detected under contracts/scripts/ (it does not exist
# yet at the time this ops layer was written — the contract says it will). If it
# is absent, we FALL BACK to a direct `sui client publish` so the demo loop is
# still runnable, and emit a best-effort deployment.json. The fallback is clearly
# labeled and prints a warning so nobody mistakes it for A's canonical output.
#
# Usage: deploy.sh [--force-fallback]
# ---------------------------------------------------------------------------
set -euo pipefail
# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

FORCE_FALLBACK=0
[ "${1:-}" = "--force-fallback" ] && FORCE_FALLBACK=1

# Candidate paths for A's deploy script, in priority order.
A_DEPLOY_CANDIDATES=(
  "${GIX_CONTRACTS_DIR}/scripts/deploy.sh"
  "${GIX_CONTRACTS_DIR}/scripts/deploy-localnet.sh"
  "${GIX_CONTRACTS_DIR}/scripts/publish.sh"
  "${GIX_CONTRACTS_DIR}/scripts/deploy.ts"
  "${GIX_CONTRACTS_DIR}/scripts/deploy.js"
)

find_a_deploy_script() {
  for c in "${A_DEPLOY_CANDIDATES[@]}"; do
    [ -f "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

run_a_deploy_script() {
  local script="$1"
  log "delegating to contracts deploy script: ${script}"
  case "$script" in
    *.sh) bash "$script" ;;
    *.ts) require_node; ( cd "${GIX_CONTRACTS_DIR}" && npx --yes tsx "$script" ) ;;
    *.js) require_node; ( cd "${GIX_CONTRACTS_DIR}" && node "$script" ) ;;
    *) die "don't know how to run deploy script: ${script}" ;;
  esac
}

# --- Fallback: publish the package directly and synthesize deployment.json ---
# This is a DEV CONVENIENCE so the end-to-end loop runs before A's script lands.
# It publishes the package and records packageId; Config/AdminCap are discovered
# from the publish object-changes if the package's init creates them (config.move
# does). Markets are left empty unless A exposes create_market — we cannot guess
# the Credit type witnesses, so markets[] may be [] in fallback mode. The harness
# must tolerate an empty markets[] in fallback (documented in the contract).
fallback_publish() {
  warn "FALLBACK MODE: A's deploy script not found — publishing package directly."
  warn "This deployment.json is dev-only; A's canonical script supersedes it."

  if [ ! -f "${GIX_CONTRACTS_DIR}/Move.toml" ]; then
    die "no Move package at ${GIX_CONTRACTS_DIR} (Move.toml missing)"
  fi

  local admin out
  admin="$(active_address)" || die "no active sui address; run 'sui client new-address ed25519'"
  log "publishing gix from ${GIX_CONTRACTS_DIR} as ${admin} ..."

  # --skip-dependency-verification speeds localnet; capture JSON object changes.
  out="${GIX_RUN_DIR}/publish.json"
  mkrundir
  if ! sui client publish "${GIX_CONTRACTS_DIR}" \
        --gas-budget "${GIX_PUBLISH_GAS_BUDGET}" \
        --json >"${out}" 2>"${GIX_RUN_DIR}/publish.err"; then
    err "sui client publish failed:"; tail -n 30 "${GIX_RUN_DIR}/publish.err" >&2 || true
    die "publish failed"
  fi

  # Extract package id + created shared/owned objects from objectChanges.
  local pkg cfg adminCap usdcType clock
  pkg="$(jq -er '.objectChanges[] | select(.type=="published") | .packageId' "${out}")" \
    || die "could not parse packageId from publish output"
  # Config is the shared object whose type ends in ::config::Config
  cfg="$(jq -er --arg p "$pkg" \
        '[.objectChanges[] | select(.type=="created" and (.objectType // "" | test("::config::Config$")))][0].objectId // empty' \
        "${out}")"
  adminCap="$(jq -er \
        '[.objectChanges[] | select(.type=="created" and (.objectType // "" | test("::config::AdminCap$")))][0].objectId // empty' \
        "${out}")"
  usdcType="${pkg}::mock_usdc::MOCK_USDC"
  clock="0x6"

  log "writing fallback deployment.json -> ${GIX_DEPLOYMENT_JSON}"
  jq -n \
    --arg network "localnet" \
    --arg packageId "$pkg" \
    --arg configId "${cfg:-}" \
    --arg adminCapId "${adminCap:-}" \
    --arg usdcType "$usdcType" \
    --arg clockId "$clock" \
    --arg admin "$admin" \
    '{
       network: $network,
       packageId: $packageId,
       configId: $configId,
       adminCapId: $adminCapId,
       usdcType: $usdcType,
       clockId: $clockId,
       markets: [],
       accounts: { admin: $admin, providers: [], consumers: [] },
       _generatedBy: "ops/scripts/deploy.sh fallback (NOT canonical; A supersedes)"
     }' >"${GIX_DEPLOYMENT_JSON}"
}

main() {
  require_base_tools

  if ! localnet_is_up; then
    err "localnet is not up at ${GIX_LOCALNET_RPC}."
    dim "      run 'make localnet' first."
    exit 1
  fi
  ensure_localnet_env || true

  local a_script=""
  if [ "${FORCE_FALLBACK}" -eq 0 ]; then
    a_script="$(find_a_deploy_script || true)"
  fi

  if [ -n "${a_script}" ]; then
    run_a_deploy_script "${a_script}"
  else
    [ "${FORCE_FALLBACK}" -eq 1 ] && log "--force-fallback set; skipping A's deploy script"
    fallback_publish
  fi

  # Validate whatever was produced against the binding schema.
  if validate_deployment_json; then
    local pkg; pkg="$(deployment_get '.packageId' 2>/dev/null || echo '?')"
    local nmk;  nmk="$(deployment_get '.markets | length' 2>/dev/null || echo 0)"
    ok "deploy complete: package ${pkg}, ${nmk} market(s)"
    [ "${nmk}" = "0" ] && warn "0 markets in deployment.json — fund/stream may have nothing to trade until A creates markets"
  else
    die "deploy produced an invalid deployment.json"
  fi
}
main "$@"
