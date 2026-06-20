#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ops/scripts/fund.sh — create and fund GIX test accounts on localnet.
#
# For each requested provider/consumer it:
#   1. Creates a fresh ed25519 keypair via `sui client new-address` (idempotent
#      on alias — reuses an existing gix-* alias if present).
#   2. Funds it with localnet SUI gas via the faucet (`sui client faucet`).
#   3. Mints MOCK_USDC into it via the package faucet entry
#      `gix::mock_usdc::mint(amount, recipient, ctx)` (integration contract §
#      "A → world"). Skipped with a clear warning if the package has no
#      mock_usdc module yet (A not built) or markets are absent.
#
# Finally it patches deployment.json's `accounts` block with the funded
# addresses so the harness can read them.
#
# Usage:
#   fund.sh [--providers N] [--consumers M] [--sui-amount MIST]
#           [--usdc-amount BASEUNITS]
# Defaults: 2 providers, 3 consumers (matches baseline.json), large balances.
# ---------------------------------------------------------------------------
set -euo pipefail
# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

N_PROVIDERS=2
N_CONSUMERS=3
# MOCK_USDC is 6 decimals (integration contract). 1_000_000 base units = 1 USDC.
USDC_AMOUNT="${USDC_AMOUNT:-100000000000}"   # 100,000 MOCK_USDC default
SUI_FAUCET_CALLS="${SUI_FAUCET_CALLS:-1}"    # 1 faucet grant is ~plenty on localnet

while [ $# -gt 0 ]; do
  case "$1" in
    --providers) shift; N_PROVIDERS="${1:?}" ;;
    --consumers) shift; N_CONSUMERS="${1:?}" ;;
    --usdc-amount) shift; USDC_AMOUNT="${1:?}" ;;
    --sui-faucet-calls) shift; SUI_FAUCET_CALLS="${1:?}" ;;
    *) warn "unknown arg: $1" ;;
  esac
  shift
done

# Create-or-reuse an address under a stable alias. Echoes the 0x address.
ensure_address() {
  local alias="$1" addr
  # Already in keystore?
  addr="$(sui keytool list --json 2>/dev/null \
          | jq -er --arg a "$alias" '.[]? | select(.alias==$a) | .suiAddress' 2>/dev/null | head -n1 || true)"
  if [ -n "${addr:-}" ] && [ "${addr}" != "null" ]; then
    printf '%s\n' "$addr"; return 0
  fi
  # Create new. new-address --json returns the new address.
  addr="$(sui client new-address ed25519 "$alias" --json 2>/dev/null \
          | jq -er '.address // .suiAddress // empty' 2>/dev/null || true)"
  if [ -z "${addr:-}" ]; then
    # Older CLIs print non-JSON; re-query the keystore by alias.
    sui client new-address ed25519 "$alias" >/dev/null 2>&1 || true
    addr="$(sui keytool list --json 2>/dev/null \
            | jq -er --arg a "$alias" '.[]? | select(.alias==$a) | .suiAddress' 2>/dev/null | head -n1 || true)"
  fi
  [ -n "${addr:-}" ] || die "failed to create address for alias ${alias}"
  printf '%s\n' "$addr"
}

faucet_sui() {
  local addr="$1" i
  for ((i=0; i<SUI_FAUCET_CALLS; i++)); do
    sui client faucet --address "$addr" --url "${GIX_LOCALNET_FAUCET}" >/dev/null 2>&1 \
      || warn "faucet grant failed for ${addr} (is the faucet up?)"
    sleep 1
  done
}

# Mint MOCK_USDC via the package faucet. No-op (warn) if module not present.
PKG=""
USDC_AVAILABLE=0
detect_usdc() {
  PKG="$(deployment_get '.packageId' 2>/dev/null || true)"
  [ -n "${PKG:-}" ] || { warn "no packageId in deployment.json; skipping MOCK_USDC mint"; return 1; }
  # Probe the module by asking for its normalized definition.
  if sui client call --package "$PKG" --module mock_usdc --function mint \
       --args 1 0x0 --gas-budget "${GIX_CALL_GAS_BUDGET}" --dry-run >/dev/null 2>&1; then
    USDC_AVAILABLE=1
  else
    # dry-run may fail for arg reasons even when module exists; do a lighter probe.
    USDC_AVAILABLE=1   # assume present; real call below will surface a clear error
  fi
  return 0
}

mint_usdc() {
  local addr="$1"
  [ "${USDC_AVAILABLE}" -eq 1 ] || return 0
  if ! sui client call --package "$PKG" --module mock_usdc --function mint \
        --args "${USDC_AMOUNT}" "$addr" \
        --gas-budget "${GIX_CALL_GAS_BUDGET}" >/dev/null 2>"${GIX_RUN_DIR}/mint.err"; then
    warn "MOCK_USDC mint failed for ${addr} (module may not exist yet):"
    dim "      $(tail -n1 "${GIX_RUN_DIR}/mint.err" 2>/dev/null)"
    USDC_AVAILABLE=0   # stop hammering a missing module
  fi
}

main() {
  require_base_tools
  mkrundir
  localnet_is_up || die "localnet not up; run 'make localnet'"
  find_deployment_json >/dev/null || die "deployment.json not found; run 'make deploy'"
  ensure_localnet_env || true

  local admin; admin="$(active_address)" || die "no active sui address"
  ok "admin / deployer address: ${admin}"

  detect_usdc || true

  local providers=() consumers=() i addr
  log "creating + funding ${N_PROVIDERS} provider(s) and ${N_CONSUMERS} consumer(s)..."

  for ((i=1; i<=N_PROVIDERS; i++)); do
    addr="$(ensure_address "gix-provider-${i}")"
    faucet_sui "$addr"
    mint_usdc "$addr"
    providers+=("$addr")
    ok "provider-${i}: ${addr}"
  done
  for ((i=1; i<=N_CONSUMERS; i++)); do
    addr="$(ensure_address "gix-consumer-${i}")"
    faucet_sui "$addr"
    mint_usdc "$addr"
    consumers+=("$addr")
    ok "consumer-${i}: ${addr}"
  done

  # Fund the admin too (it pays gas for deploy/market ops).
  faucet_sui "$admin"

  # Patch deployment.json accounts block. Build JSON arrays empty-safely (an
  # empty bash array must yield [], not [""]).
  local f tmp prov_json cons_json
  f="$(find_deployment_json)"
  tmp="$(mktemp)"
  if [ "${#providers[@]}" -eq 0 ]; then prov_json='[]'; else prov_json="$(printf '%s\n' "${providers[@]}" | jq -R . | jq -s .)"; fi
  if [ "${#consumers[@]}" -eq 0 ]; then cons_json='[]'; else cons_json="$(printf '%s\n' "${consumers[@]}" | jq -R . | jq -s .)"; fi
  jq \
    --arg admin "$admin" \
    --argjson providers "$prov_json" \
    --argjson consumers "$cons_json" \
    '.accounts = { admin: $admin, providers: $providers, consumers: $consumers }' \
    "$f" >"$tmp" && mv "$tmp" "$f"

  ok "funded accounts written to ${f}"
  [ "${USDC_AVAILABLE}" -eq 1 ] \
    && ok "MOCK_USDC minted (${USDC_AMOUNT} base units each)" \
    || warn "MOCK_USDC NOT minted (gix::mock_usdc absent) — accounts have SUI gas only"
}
main "$@"
