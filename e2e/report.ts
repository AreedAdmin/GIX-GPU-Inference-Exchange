/**
 * Minimal JUnit-XML + human-summary reporter for the E2E harness (§5 Outputs).
 *
 * Each asserted invariant / audit check / scenario step becomes a "test case". The harness
 * exits nonzero on any failure (the CI gate), and writes a JUnit file consumable by CI.
 */

import { writeFileSync } from "node:fs";

export interface Case {
  suite: string;
  name: string;
  ok: boolean;
  detail: string;
  /** Milliseconds the step took (optional). */
  timeMs?: number;
}

export class Reporter {
  private readonly cases: Case[] = [];
  private readonly t0 = Date.now();

  record(c: Case): void {
    this.cases.push(c);
    const tag = c.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    // eslint-disable-next-line no-console
    console.log(`  [${tag}] ${c.suite} :: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  /** Record + return ok, so callers can `if (!rep.assert(...)) ...`. */
  assert(suite: string, name: string, ok: boolean, detail = ""): boolean {
    this.record({ suite, name, ok, detail });
    return ok;
  }

  get failures(): number {
    return this.cases.filter((c) => !c.ok).length;
  }

  get total(): number {
    return this.cases.length;
  }

  summary(): string {
    const fails = this.failures;
    const dur = ((Date.now() - this.t0) / 1000).toFixed(1);
    return `${this.total - fails}/${this.total} checks passed in ${dur}s` + (fails ? ` — ${fails} FAILED` : " — ALL GREEN");
  }

  writeJUnit(path: string): void {
    const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
    const suites = new Map<string, Case[]>();
    for (const c of this.cases) {
      if (!suites.has(c.suite)) suites.set(c.suite, []);
      suites.get(c.suite)!.push(c);
    }
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n`;
    for (const [suite, cs] of suites) {
      const fails = cs.filter((c) => !c.ok).length;
      xml += `  <testsuite name="${esc(suite)}" tests="${cs.length}" failures="${fails}">\n`;
      for (const c of cs) {
        xml += `    <testcase name="${esc(c.name)}"${c.timeMs ? ` time="${(c.timeMs / 1000).toFixed(3)}"` : ""}>`;
        if (!c.ok) xml += `\n      <failure message="${esc(c.detail)}"/>\n    `;
        xml += `</testcase>\n`;
      }
      xml += `  </testsuite>\n`;
    }
    xml += `</testsuites>\n`;
    writeFileSync(path, xml);
  }
}
