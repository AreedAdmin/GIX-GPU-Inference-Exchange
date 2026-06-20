#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ops/scripts/demo.sh — one-command end-to-end M1 demo.
#
# Orchestrates the full §C flow:
#   1. ensure localnet is up (start it if needed)
#   2. deploy gix (delegates to A's script or falls back) -> deployment.json
#   3. create + fund test accounts (SUI gas + MOCK_USDC)
#   4. run the harness streamer against a scenario (workstream B):
#        npm run stream -- --scenario <scenario>   (run from harness/)
#   5. capture the streamer tally and render the run summary.
#
# Degrades gracefully if the harness isn't built yet: it prints exactly what to
# run once harness/ exists, so the deploy+fund half of the demo still works.
#
# Usage: demo.sh [--scenario PATH] [--no-localnet] [--summary-md FILE]
# Default scenario: examples/scenarios/baseline.json (the §B baseline).
# ---------------------------------------------------------------------------
set -euo pipefail
# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

SCENARIO="${GIX_EXAMPLES_DIR}/scenarios/baseline.json"
MANAGE_LOCALNET=1
SUMMARY_MD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) shift; SCENARIO="${1:?}" ;;
    --no-localnet) MANAGE_LOCALNET=0 ;;
    --summary-md) shift; SUMMARY_MD="${1:?}" ;;
    *) warn "unknown arg: $1" ;;
  esac
  shift
done

SCRIPTS="${GIX_OPS_DIR}/scripts"

step() { printf '\n%s━━ %s ━━%s\n' "${_c_blu}" "$*" "${_c_rst}" >&2; }

main() {
  require_base_tools
  mkrundir
  [ -f "${SCENARIO}" ] || die "scenario not found: ${SCENARIO}"
  ok "scenario: ${SCENARIO}"

  # 1) localnet
  step "1/5  localnet"
  if [ "${MANAGE_LOCALNET}" -eq 1 ]; then
    bash "${SCRIPTS}/localnet.sh" start || die "could not start localnet"
  else
    localnet_is_up || die "localnet not up and --no-localnet set"
    ok "using already-running localnet"
  fi

  # 2) deploy
  step "2/5  deploy gix"
  bash "${SCRIPTS}/deploy.sh"

  # 3) fund
  step "3/5  fund accounts"
  # Match the scenario's provider/consumer counts if present.
  local np nc
  np="$(jq -er '.providers // .numProviders // 2' "${SCENARIO}" 2>/dev/null || echo 2)"
  nc="$(jq -er '.consumers // .numConsumers // 3' "${SCENARIO}" 2>/dev/null || echo 3)"
  bash "${SCRIPTS}/fund.sh" --providers "${np}" --consumers "${nc}"

  # 4) stream via harness
  step "4/5  stream scenario via harness"
  local tally="${GIX_RUN_DIR}/tally.json"
  rm -f "${tally}"
  if [ -f "${GIX_HARNESS_DIR}/package.json" ]; then
    log "running: npm run stream -- --scenario ${SCENARIO}  (cwd: ${GIX_HARNESS_DIR})"
    # The harness owns stream output. We also point it at a tally file via env so
    # the summary step can render it; the harness is free to ignore GIX_TALLY_OUT
    # and emit NDJSON on stdout instead (we tee stdout as a fallback source).
    if ( cd "${GIX_HARNESS_DIR}" \
         && GIX_TALLY_OUT="${tally}" GIX_DEPLOYMENT_JSON="$(find_deployment_json)" \
            npm run --silent stream -- --scenario "${SCENARIO}" ) \
         2>&1 | tee "${GIX_RUN_DIR}/stream.log"; then
      ok "stream completed"
    else
      warn "harness stream exited non-zero (see ${GIX_RUN_DIR}/stream.log)"
    fi
    # If the harness didn't write a tally file, try to recover one from its stdout.
    if [ ! -f "${tally}" ] && [ -f "${GIX_RUN_DIR}/stream.log" ]; then
      cp "${GIX_RUN_DIR}/stream.log" "${tally}"
    fi
  else
    warn "harness/ not built yet (no harness/package.json)."
    dim "      Once workstream B lands, the demo will run:"
    dim "        cd ${GIX_HARNESS_DIR} && npm run stream -- --scenario ${SCENARIO}"
    dim "      deploy + fund already completed; deployment.json is ready for it."
  fi

  # 5) summary
  step "5/5  run summary"
  local summary_args=(--format console)
  [ -f "${tally}" ] && summary_args=(--input "${tally}" --format console)
  if [ -n "${SUMMARY_MD}" ]; then
    node "${SCRIPTS}/run-summary.js" "${summary_args[@]}"
    node "${SCRIPTS}/run-summary.js" ${tally:+--input "${tally}"} --format md --out "${SUMMARY_MD}"
    ok "markdown summary written to ${SUMMARY_MD}"
  else
    node "${SCRIPTS}/run-summary.js" "${summary_args[@]}"
  fi

  ok "demo flow complete"
}
main "$@"
