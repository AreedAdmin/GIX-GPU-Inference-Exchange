#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * ops/scripts/run-summary.js — render the streamer's run tally as a console
 * table and/or a Markdown report.
 *
 * The harness (workstream B) streams "structured logs + a running tally
 * (orders, fills, jobs, settled, refunded, slashed, $ escrowed, $ slashed)"
 * (integration contract §B). At end-of-run it is expected to emit a final
 * tally object. This renderer is the §C "console/markdown run-summary
 * renderer" — it is decoupled from HOW the harness emits the tally:
 *
 *   • `--input <file>`  read a JSON tally object from a file, OR
 *   • piped stdin       read JSON (one object) or NDJSON (last `{"tally":...}`
 *                       / last object with a `summary`/`tally` shape wins), OR
 *   • no input          render a zeroed template (useful for `make -n` / docs).
 *
 * Tally schema (superset; every field optional, defaults to 0/—):
 *   {
 *     "scenario": "baseline",
 *     "durationMs": 60000,
 *     "orders": 120, "fills": 110, "jobs": 110,
 *     "settled": 95, "refunded": 8, "slashed": 7,
 *     "usdcEscrowed": "1234.50", "usdcSettled": "1010.00",
 *     "usdcRefunded": "120.00", "usdcSlashed": "84.50",
 *     "slashBreakdown": { "invalid": 3, "missing": 2, "sla": 2, "liveness": 0 },
 *     "byMarket": [ { "name": "H100-...", "jobs": 60, "settled": 55 } ],
 *     "errors": 0
 *   }
 *
 * Usage:
 *   run-summary.js [--input tally.json] [--format console|md|both] [--out file.md]
 *   cat tally.json | run-summary.js --format md
 * ------------------------------------------------------------------------- */
'use strict';
const fs = require('fs');

function parseArgs(argv) {
  const a = { format: 'console', input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--input' || v === '-i') a.input = argv[++i];
    else if (v === '--format' || v === '-f') a.format = argv[++i];
    else if (v === '--out' || v === '-o') a.out = argv[++i];
    else if (v === '--help' || v === '-h') a.help = true;
  }
  return a;
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Accept a single JSON object, or NDJSON where we want the final tally-like line.
function extractTally(raw) {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  // Try whole-string JSON first.
  try {
    const obj = JSON.parse(trimmed);
    return obj.tally || obj.summary || obj;
  } catch {
    /* fall through to NDJSON */
  }
  // NDJSON: scan lines bottom-up for the last parseable object that looks like a tally.
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      const t = obj.tally || obj.summary || obj;
      if (t && (t.orders != null || t.jobs != null || t.settled != null)) return t;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

const ZERO_TALLY = {
  scenario: '—',
  durationMs: 0,
  orders: 0, fills: 0, jobs: 0,
  settled: 0, refunded: 0, slashed: 0,
  usdcEscrowed: '0', usdcSettled: '0', usdcRefunded: '0', usdcSlashed: '0',
  slashBreakdown: { invalid: 0, missing: 0, sla: 0, liveness: 0 },
  byMarket: [],
  errors: 0,
};

function withDefaults(t) {
  const m = Object.assign({}, ZERO_TALLY, t || {});
  m.slashBreakdown = Object.assign({}, ZERO_TALLY.slashBreakdown, (t && t.slashBreakdown) || {});
  m.byMarket = (t && t.byMarket) || [];
  return m;
}

function pct(n, d) {
  if (!d) return '—';
  return ((100 * n) / d).toFixed(1) + '%';
}
function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderConsole(t) {
  const L = [];
  const rule = '─'.repeat(54);
  L.push('');
  L.push(`  GIX run summary — scenario: ${t.scenario}`);
  L.push(`  ${rule}`);
  const row = (k, v) => L.push(`  ${k.padEnd(22)} ${String(v)}`);
  row('duration', fmtDur(t.durationMs));
  row('orders → fills', `${t.orders} → ${t.fills}  (fill rate ${pct(t.fills, t.orders)})`);
  row('jobs created', t.jobs);
  row('settled', `${t.settled}  (${pct(t.settled, t.jobs)} of jobs)`);
  row('refunded', `${t.refunded}  (${pct(t.refunded, t.jobs)})`);
  row('slashed', `${t.slashed}  (${pct(t.slashed, t.jobs)})`);
  L.push(`  ${rule}`);
  row('USDC escrowed', t.usdcEscrowed);
  row('USDC settled→prov', t.usdcSettled);
  row('USDC refunded', t.usdcRefunded);
  row('USDC slashed', t.usdcSlashed);
  L.push(`  ${rule}`);
  const sb = t.slashBreakdown;
  row('slash: invalid', sb.invalid);
  row('slash: missing', sb.missing);
  row('slash: sla', sb.sla);
  row('slash: liveness', sb.liveness);
  if (t.byMarket && t.byMarket.length) {
    L.push(`  ${rule}`);
    L.push('  per-market:');
    for (const mk of t.byMarket) {
      L.push(`    • ${mk.name || mk.id || '?'}: jobs ${mk.jobs ?? '—'}, settled ${mk.settled ?? '—'}`);
    }
  }
  if (t.errors) {
    L.push(`  ${rule}`);
    row('errors', t.errors);
  }
  L.push('');
  return L.join('\n');
}

function renderMarkdown(t) {
  const sb = t.slashBreakdown;
  const lines = [];
  lines.push(`# GIX Run Summary — \`${t.scenario}\``);
  lines.push('');
  lines.push(`_Duration: ${fmtDur(t.durationMs)}_`);
  lines.push('');
  lines.push('| Metric | Value | Rate |');
  lines.push('| --- | ---: | ---: |');
  lines.push(`| Orders | ${t.orders} | — |`);
  lines.push(`| Fills | ${t.fills} | ${pct(t.fills, t.orders)} of orders |`);
  lines.push(`| Jobs created | ${t.jobs} | — |`);
  lines.push(`| Settled | ${t.settled} | ${pct(t.settled, t.jobs)} |`);
  lines.push(`| Refunded | ${t.refunded} | ${pct(t.refunded, t.jobs)} |`);
  lines.push(`| Slashed | ${t.slashed} | ${pct(t.slashed, t.jobs)} |`);
  lines.push('');
  lines.push('| USDC flow | Amount |');
  lines.push('| --- | ---: |');
  lines.push(`| Escrowed | ${t.usdcEscrowed} |`);
  lines.push(`| Settled → provider | ${t.usdcSettled} |`);
  lines.push(`| Refunded → consumer | ${t.usdcRefunded} |`);
  lines.push(`| Slashed | ${t.usdcSlashed} |`);
  lines.push('');
  lines.push('| Slash reason | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Invalid attestation | ${sb.invalid} |`);
  lines.push(`| Missing attestation | ${sb.missing} |`);
  lines.push(`| SLA breach | ${sb.sla} |`);
  lines.push(`| Liveness fault | ${sb.liveness} |`);
  if (t.byMarket && t.byMarket.length) {
    lines.push('');
    lines.push('| Market | Jobs | Settled |');
    lines.push('| --- | ---: | ---: |');
    for (const mk of t.byMarket) {
      lines.push(`| ${mk.name || mk.id || '?'} | ${mk.jobs ?? '—'} | ${mk.settled ?? '—'} |`);
    }
  }
  if (t.errors) {
    lines.push('');
    lines.push(`> ⚠️ ${t.errors} error(s) recorded during the run.`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: run-summary.js [--input tally.json] [--format console|md|both] [--out file.md]');
    process.exit(0);
  }
  let raw = '';
  if (args.input) {
    if (!fs.existsSync(args.input)) {
      console.error(`run-summary: input not found: ${args.input}`);
      process.exit(1);
    }
    raw = fs.readFileSync(args.input, 'utf8');
  } else if (!process.stdin.isTTY) {
    raw = readStdinSync();
  }

  const parsed = extractTally(raw);
  if (raw && raw.trim() && !parsed) {
    console.error('run-summary: could not find a tally object in input; rendering zeroed template.');
  }
  const t = withDefaults(parsed);

  const fmt = args.format || 'console';
  let mdOut = null;
  if (fmt === 'console' || fmt === 'both') console.log(renderConsole(t));
  if (fmt === 'md' || fmt === 'both') {
    mdOut = renderMarkdown(t);
    if (args.out) {
      fs.writeFileSync(args.out, mdOut);
      console.error(`run-summary: wrote ${args.out}`);
    } else if (fmt === 'md') {
      console.log(mdOut);
    } else {
      console.log('\n' + mdOut);
    }
  }
}

main();
