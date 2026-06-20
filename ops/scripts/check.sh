#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ops/scripts/check.sh — offline sanity checks (no localnet required).
#
# Validates: bash syntax of all ops scripts, JSON validity + minimal schema of
# every scenario, JSON/JSONL validity of fixtures, and that the run-summary
# renderer works on a sample tally. Used by `make check` and as a CI smoke test.
# ---------------------------------------------------------------------------
set -euo pipefail
# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

fail=0
note_fail() { err "$*"; fail=1; }

step() { printf '\n%s── %s ──%s\n' "${_c_blu}" "$*" "${_c_rst}" >&2; }

# 1) bash -n on every shell script
step "bash syntax"
while IFS= read -r f; do
  if bash -n "$f" 2>/dev/null; then ok "syntax ok: ${f#$GIX_ROOT/}"; else note_fail "syntax error: $f"; fi
done < <(find "${GIX_OPS_DIR}" -name '*.sh' -type f | sort)

# 2) node syntax check on run-summary
step "node syntax"
if node --check "${GIX_OPS_DIR}/scripts/run-summary.js" 2>/dev/null; then
  ok "node --check run-summary.js"
else
  note_fail "run-summary.js failed node --check"
fi

# 3) scenarios: valid JSON + required top-level keys
step "scenarios"
SCEN_KEYS=(name orderRatePerMin durationSec providers consumers qty price faults)
for s in "${GIX_EXAMPLES_DIR}"/scenarios/*.json; do
  [ -e "$s" ] || { warn "no scenario files found"; break; }
  case "$s" in *.schema.json) continue ;; esac   # skip JSON Schema docs
  if ! jq -e . "$s" >/dev/null 2>&1; then note_fail "invalid JSON: $s"; continue; fi
  miss=()
  for k in "${SCEN_KEYS[@]}"; do
    jq -e "has(\"$k\")" "$s" >/dev/null 2>&1 || miss+=("$k")
  done
  if [ "${#miss[@]}" -eq 0 ]; then ok "scenario ok: $(basename "$s")"; else note_fail "$(basename "$s") missing keys: ${miss[*]}"; fi
done

# 4) fixtures: prompts NDJSON + latency profile JSON
step "fixtures"
for j in "${GIX_EXAMPLES_DIR}"/fixtures/*.json; do
  [ -e "$j" ] || break
  if jq -e . "$j" >/dev/null 2>&1; then ok "fixture json ok: $(basename "$j")"; else note_fail "invalid fixture JSON: $j"; fi
done
for nd in "${GIX_EXAMPLES_DIR}"/fixtures/*.jsonl; do
  [ -e "$nd" ] || break
  lineno=0; bad=0
  while IFS= read -r line; do
    lineno=$((lineno+1))
    [ -z "$line" ] && continue
    echo "$line" | jq -e . >/dev/null 2>&1 || { note_fail "$(basename "$nd"):$lineno invalid JSON line"; bad=1; }
  done < "$nd"
  [ "$bad" -eq 0 ] && ok "fixture jsonl ok: $(basename "$nd") (${lineno} lines)"
done

# 5) run-summary renders a sample tally
step "run-summary smoke"
sample='{"scenario":"selftest","durationMs":1000,"orders":10,"fills":9,"jobs":9,"settled":7,"refunded":1,"slashed":1,"slashBreakdown":{"invalid":1}}'
if echo "$sample" | node "${GIX_OPS_DIR}/scripts/run-summary.js" --format md >/dev/null 2>&1; then
  ok "run-summary renders sample tally"
else
  note_fail "run-summary failed on sample tally"
fi

step "result"
if [ "$fail" -eq 0 ]; then ok "all checks passed"; else err "checks FAILED"; fi
exit "$fail"
