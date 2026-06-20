#!/usr/bin/env bash
#
# GIX testnet (re)publish + setup for the DBUSDC quote dollar + the GB10·Qwen market.
# =================================================================================
#
# This stages — but DOES NOT by default execute — the testnet bring-up of the
# *quote-coin-parameterized* `gix` package (the generic phantom `Q`, see
# docs/onramp-dbusdc-plan.md) with the testnet dollar pinned to **DBUSDC** and a new
# **GB10 · Qwen3.6-35b** credit market.
#
# It is deliberately a DRY-RUN by default. Nothing is published or called unless you pass
# `--confirm`. Even with `--confirm` it writes a SEPARATE manifest
# (`deployment.testnet.staged.json`) and NEVER touches the live `deployment.testnet.json`
# or the live package `0x0ed255b1…`. This pass is gated on the DEEP-funded integration run
# (the `Credit<GB10_QWEN>/DBUSDC` DeepBook pool is the only DEEP-gated piece).
#
# WHY a republish (not an upgrade): parameterizing the quote coin changed struct shapes
# (`Treasury<Q>`, `ProviderStake<Q>`, `Job<M, Q>`, `Escrow<Q>`), so the new package is a
# fresh publish, not a compatible upgrade of `0x0ed255b1…`. The live package keeps running
# untouched; this stages its replacement for when the DEEP gate clears.
#
# WHY no Move.toml dependency on DBUSDC: the contract never NAMES DBUSDC. The quote dollar is
# a generic phantom `Q`, so DBUSDC enters only as a `--type-args` STRING at call time
# (`init_treasury`, the market's DeepBook pool, the consumer buy PTBs). One codebase; the
# dollar is chosen per network at instantiation (MOCK_USDC localnet / DBUSDC testnet / USDC
# mainnet). No new dependency is added.
#
# Usage:
#   scripts/stage-testnet-dbusdc.sh             # DRY RUN: print the exact plan, touch nothing
#   scripts/stage-testnet-dbusdc.sh --confirm   # EXECUTE: republish + setup, write staged manifest
#
# Requirements (only for --confirm): `sui` CLI (>=1.73), `jq`, active env = testnet, a funded
# admin address.

set -euo pipefail

# --- safety posture -------------------------------------------------------------------
CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$PKG_DIR/.." && pwd)"

# Staged manifest — DISTINCT from the live deployment.testnet.json (which we never write).
OUT="${GIX_OUT:-$REPO_DIR/deployment.testnet.staged.json}"
LIVE="$REPO_DIR/deployment.testnet.json"
LIVE_PACKAGE="0x0ed255b19e62f034d3c38130959bf94e459e48b7fb4296d57ac42b1a34c93f0f"

# --- the testnet dollar (PINNED per docs/onramp-dbusdc-plan.md) -----------------------
# DBUSDC is an EXTERNAL testnet coin (verified live). Referenced as a type string only —
# the generic `Q` means the contract source never imports it.
DBUSDC_TYPE="0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC"
# The on-ramp pool (SUI -> DBUSDC) the widget swaps on; recorded for the manifest only.
SUI_DBUSDC_POOL="0x1c19362ca5"  # placeholder prefix; fill the full id when wiring the on-ramp

# --- GB10 · Qwen3.6-35b market parameters ---------------------------------------------
MARKET_NAME="GB10-qwen3.6-35b"
GPU_CLASS="GB10"
SCU_TOKENS="${GIX_SCU_TOKENS:-1000}"
SLA_P99_MS="${GIX_SLA_P99_MS:-30000}"          # ~p99 30s interactive SLA
MODEL_URI="qwen3.6-35b/vllm"
WALRUS_BLOB_ID="${GIX_QWEN_WALRUS_BLOB_ID:-walrus-blob-qwen35b}"
MODEL_HASH="${GIX_QWEN_MODEL_HASH:-model-hash-qwen35b}"
# NOTE: testnet is NOT localnet — there is NO mock measurement here. The real runtime
# measurement is added later via the signed-attestation path / a non-MOCK measurement; the
# `add_measurement` guard refuses MOCK-prefixed bytes once `is_localnet=false`.
QWEN_MEASUREMENT="${GIX_QWEN_MEASUREMENT:-}"    # set to the real measurement bytes when known

# The new credit witness type (provided by this republished package; PKG fills in at publish).
CREDIT_WITNESS_SUFFIX="::markets::M_GB10_QWEN35B"

GAS_BUDGET="${GIX_GAS_BUDGET:-200000000}"

say()  { printf '\033[1;36m[gix-stage]\033[0m %s\n' "$*" >&2; }
plan() { printf '\033[1;33m  would run:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[gix-stage ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# --- guard rails ----------------------------------------------------------------------
say "LIVE deployment ($LIVE_PACKAGE) and $LIVE will NOT be touched."
say "staged manifest target: $OUT"

if [ "$CONFIRM" -eq 0 ]; then
  cat >&2 <<EOF

$(printf '\033[1;35m== DRY RUN ==\033[0m')  (pass --confirm to execute)

This is the staged DEEP-gated testnet bring-up of the quote-coin-parameterized package.
No publish, no on-chain call, and no file write happen in dry-run mode.

Plan (each step is a real testnet tx ONLY under --confirm):

  0. Sanity: assert active-env == testnet and an admin address has gas.

  1. REPUBLISH (gas-only) the generic-Q package — a FRESH package id (NOT $LIVE_PACKAGE):
EOF
  plan "( cd $PKG_DIR && sui client publish . --gas-budget $GAS_BUDGET --json )"
  cat >&2 <<EOF
     Discover from publish effects: PKG, CONFIG, ADMIN_CAP, ALLOWLIST,
     the auto-seeded localnet MOCK_USDC Treasury, and the MOCK_USDC Faucet.

  2. Publish the DBUSDC-denominated Treasury (the dollar testnet settles in). 'Q'=DBUSDC is
     a TYPE-ARG only — the package source never imports DBUSDC:
EOF
  plan "sui client call --package \$PKG --module settlement --function init_treasury \\"
  plan "    --type-args $DBUSDC_TYPE --args \$ADMIN_CAP --gas-budget $GAS_BUDGET"
  cat >&2 <<EOF
     -> discover the new Treasury<DBUSDC> object id (DBUSDC_TREASURY_ID).

  3. K4: flip the on-chain localnet flag OFF (mock attestation + MOCK measurements then abort):
EOF
  plan "sui client call --package \$PKG --module config --function set_is_localnet \\"
  plan "    --args \$ADMIN_CAP \$CONFIG false --gas-budget $GAS_BUDGET"
  cat >&2 <<EOF

  4. Register the Qwen ModelRecord (no MOCK measurement on testnet). If a real measurement is
     known (GIX_QWEN_MEASUREMENT set), add it; otherwise register the model only and add the
     measurement later via the signed-attestation path:
EOF
  if [ -n "$QWEN_MEASUREMENT" ]; then
    plan "sui client call --package \$PKG --module governance \\"
    plan "    --function register_model_with_measurement \\"
    plan "    --args \$ADMIN_CAP \$CONFIG \$ALLOWLIST \\"
    plan "           \"$MODEL_URI\" \"$WALRUS_BLOB_ID\" \"$MODEL_HASH\" \"$QWEN_MEASUREMENT\" \\"
    plan "    --gas-budget $GAS_BUDGET   -> discover MODEL_ID"
  else
    plan "sui client call --package \$PKG --module registry --function register_model \\"
    plan "    --args \$ADMIN_CAP \$CONFIG \"$MODEL_URI\" \"$WALRUS_BLOB_ID\" \"$MODEL_HASH\" \\"
    plan "    --gas-budget $GAS_BUDGET   -> discover MODEL_ID"
    say  "(GIX_QWEN_MEASUREMENT unset: model registered WITHOUT a measurement — add the real one later)"
  fi
  cat >&2 <<EOF

  5. Create the GB10·Qwen market. Credit witness = \$PKG$CREDIT_WITNESS_SUFFIX. The market is
     coin-agnostic; DBUSDC is bound as the quote at the DeepBook-pool step (6) and in buy PTBs:
EOF
  plan "sui client call --package \$PKG --module market --function create_market \\"
  plan "    --type-args \$PKG$CREDIT_WITNESS_SUFFIX \\"
  plan "    --args \$ADMIN_CAP \$CONFIG \"$MARKET_NAME\" \"$GPU_CLASS\" \$MODEL_ID $SCU_TOKENS $SLA_P99_MS \\"
  plan "    --gas-budget $GAS_BUDGET   -> discover MARKET_ID"
  cat >&2 <<EOF

  6. DEEP-GATED, DEFERRED — set the market's DeepBook pool once the permissionless
     Credit<M_GB10_QWEN35B>/DBUSDC pool exists (this is the only step that needs DEEP):
EOF
  plan "sui client call --package \$PKG --module market --function set_deepbook_pool_id \\"
  plan "    --type-args \$PKG$CREDIT_WITNESS_SUFFIX \\"
  plan "    --args \$ADMIN_CAP \$MARKET_ID \$CREDIT_DBUSDC_POOL_ID --gas-budget $GAS_BUDGET"
  cat >&2 <<EOF

  7. Write $OUT (staged manifest: new PKG, configId, adminCapId, allowlistId, the MOCK_USDC
     and DBUSDC treasuries, usdcType = $DBUSDC_TYPE, the GB10·Qwen market, deepbookPoolId=null
     until step 6). The live $LIVE is left exactly as-is.

Re-run with --confirm to execute the above against the active testnet.
EOF
  exit 0
fi

# =====================================================================================
# --confirm: EXECUTE. Still never touches the live package or live manifest.
# =====================================================================================
command -v sui >/dev/null || die "sui CLI not found on PATH"
command -v jq  >/dev/null || die "jq not found on PATH"

NETWORK="$(sui client active-env 2>/dev/null || echo unknown)"
[ "$NETWORK" = "testnet" ] || die "active env is '$NETWORK', refusing — switch to testnet first (sui client switch --env testnet)"
ADMIN="$(sui client active-address)"
say "network=$NETWORK admin=$ADMIN"

obj_by_type() { # <publish_json> <type_substring>
  jq -r --arg t "$2" '
    .objectChanges[]
    | select(.type=="created" and (.objectType // "" | contains($t)))
    | .objectId' "$1" | head -n1
}

# 1. Republish (fresh package).
say "republishing generic-Q package (fresh id, NOT $LIVE_PACKAGE) ..."
PUB="$(mktemp)"
( cd "$PKG_DIR" && sui client publish . --gas-budget "$GAS_BUDGET" --json ) > "$PUB" \
  || die "publish failed"
PKG="$(jq -r '.objectChanges[] | select(.type=="published") | .packageId' "$PUB")"
[ -n "$PKG" ] && [ "$PKG" != "null" ] || die "could not parse new packageId"
[ "$PKG" != "$LIVE_PACKAGE" ] || die "refusing: new package equals the LIVE package id"
say "new packageId=$PKG"

CONFIG_ID="$(obj_by_type "$PUB" "::config::Config")"
ADMIN_CAP_ID="$(obj_by_type "$PUB" "::config::AdminCap")"
ALLOWLIST_ID="$(obj_by_type "$PUB" "::registry::MeasurementAllowlist")"
MOCK_TREASURY_ID="$(obj_by_type "$PUB" "::settlement::Treasury")"   # auto-seeded MOCK_USDC treasury
FAUCET_ID="$(obj_by_type "$PUB" "::mock_usdc::Faucet")"
for v in CONFIG_ID ADMIN_CAP_ID ALLOWLIST_ID; do
  [ -n "${!v}" ] && [ "${!v}" != "null" ] || die "could not discover $v"
done
say "config=$CONFIG_ID adminCap=$ADMIN_CAP_ID allowlist=$ALLOWLIST_ID mockTreasury=$MOCK_TREASURY_ID"

# 2. Publish the DBUSDC treasury (Q = DBUSDC as a type-arg only).
say "publishing Treasury<DBUSDC> ..."
T2="$(mktemp)"
sui client call --package "$PKG" --module settlement --function init_treasury \
  --type-args "$DBUSDC_TYPE" --args "$ADMIN_CAP_ID" \
  --gas-budget "$GAS_BUDGET" --json > "$T2" || die "init_treasury<DBUSDC> failed"
DBUSDC_TREASURY_ID="$(obj_by_type "$T2" "::settlement::Treasury")"
[ -n "$DBUSDC_TREASURY_ID" ] && [ "$DBUSDC_TREASURY_ID" != "null" ] || die "could not parse DBUSDC Treasury id"
say "dbusdcTreasury=$DBUSDC_TREASURY_ID"

# 3. K4: turn off the localnet flag.
say "setting is_localnet=false (K4) ..."
sui client call --package "$PKG" --module config --function set_is_localnet \
  --args "$ADMIN_CAP_ID" "$CONFIG_ID" false --gas-budget "$GAS_BUDGET" >/dev/null \
  || die "set_is_localnet failed"

# 4. Register the Qwen model (+ measurement if a real one is supplied).
REG="$(mktemp)"
if [ -n "$QWEN_MEASUREMENT" ]; then
  say "registering Qwen model + measurement ..."
  sui client call --package "$PKG" --module governance \
    --function register_model_with_measurement \
    --args "$ADMIN_CAP_ID" "$CONFIG_ID" "$ALLOWLIST_ID" \
           "$MODEL_URI" "$WALRUS_BLOB_ID" "$MODEL_HASH" "$QWEN_MEASUREMENT" \
    --gas-budget "$GAS_BUDGET" --json > "$REG" || die "register_model_with_measurement failed"
else
  say "registering Qwen model (no measurement — add real one later) ..."
  sui client call --package "$PKG" --module registry --function register_model \
    --args "$ADMIN_CAP_ID" "$CONFIG_ID" "$MODEL_URI" "$WALRUS_BLOB_ID" "$MODEL_HASH" \
    --gas-budget "$GAS_BUDGET" --json > "$REG" || die "register_model failed"
fi
MODEL_ID="$(obj_by_type "$REG" "::registry::ModelRecord")"
[ -n "$MODEL_ID" ] && [ "$MODEL_ID" != "null" ] || die "could not parse ModelRecord id"
say "modelId=$MODEL_ID"

# 5. Create the GB10·Qwen market.
say "creating market $MARKET_NAME ..."
MKT="$(mktemp)"
CREDIT_WITNESS="${PKG}${CREDIT_WITNESS_SUFFIX}"
sui client call --package "$PKG" --module market --function create_market \
  --type-args "$CREDIT_WITNESS" \
  --args "$ADMIN_CAP_ID" "$CONFIG_ID" "$MARKET_NAME" "$GPU_CLASS" "$MODEL_ID" "$SCU_TOKENS" "$SLA_P99_MS" \
  --gas-budget "$GAS_BUDGET" --json > "$MKT" || die "create_market failed"
MARKET_ID="$(obj_by_type "$MKT" "::market::Market")"
[ -n "$MARKET_ID" ] && [ "$MARKET_ID" != "null" ] || die "could not parse Market id"
say "marketId=$MARKET_ID"

# 6. set_deepbook_pool_id is DEEP-gated and DEFERRED — print the exact command to run later.
say "DEFERRED (DEEP-gated): once the Credit<M_GB10_QWEN35B>/DBUSDC pool exists, run:"
plan "sui client call --package $PKG --module market --function set_deepbook_pool_id \\"
plan "    --type-args $CREDIT_WITNESS \\"
plan "    --args $ADMIN_CAP_ID $MARKET_ID <CREDIT_DBUSDC_POOL_ID> --gas-budget $GAS_BUDGET"

# 7. Write the STAGED manifest (never the live one).
say "writing staged manifest $OUT (live $LIVE untouched) ..."
jq -n \
  --arg network "testnet-staged" \
  --arg packageId "$PKG" \
  --arg configId "$CONFIG_ID" \
  --arg adminCapId "$ADMIN_CAP_ID" \
  --arg allowlistId "$ALLOWLIST_ID" \
  --arg mockTreasuryId "$MOCK_TREASURY_ID" \
  --arg dbusdcTreasuryId "$DBUSDC_TREASURY_ID" \
  --arg faucetId "${FAUCET_ID:-}" \
  --arg quoteType "$DBUSDC_TYPE" \
  --arg suiDbusdcPool "$SUI_DBUSDC_POOL" \
  --arg clockId "0x6" \
  --arg admin "$ADMIN" \
  --arg marketId "$MARKET_ID" \
  --arg marketName "$MARKET_NAME" \
  --arg gpuClass "$GPU_CLASS" \
  --arg creditType "$CREDIT_WITNESS" \
  --arg modelId "$MODEL_ID" \
  --argjson scuTokens "$SCU_TOKENS" \
  --argjson slaP99Ms "$SLA_P99_MS" \
  '{
     network: $network,
     note: "STAGED quote-coin-parameterized (generic Q) testnet bring-up; DBUSDC is the testnet dollar. NOT the live deployment.",
     packageId: $packageId,
     configId: $configId,
     adminCapId: $adminCapId,
     allowlistId: $allowlistId,
     treasuries: { mockUsdc: $mockTreasuryId, dbusdc: $dbusdcTreasuryId },
     faucetId: $faucetId,
     quoteType: $quoteType,
     onramp: { pair: "SUI->DBUSDC", poolId: $suiDbusdcPool },
     clockId: $clockId,
     markets: [
       { id: $marketId, name: $marketName, gpuClass: $gpuClass, creditType: $creditType,
         creditCoinType: ($packageId + "::credit::Credit<" + $creditType + ">"),
         quoteType: $quoteType, modelId: $modelId, scuTokens: $scuTokens, slaP99Ms: $slaP99Ms,
         deepbookPoolId: null }
     ],
     accounts: { admin: $admin }
   }' > "$OUT"

say "done. staged manifest:"
cat "$OUT" >&2
say "NOTE: the live $LIVE and live package $LIVE_PACKAGE were not modified."

rm -f "$PUB" "$T2" "$REG" "$MKT"
