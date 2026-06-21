// web/src/components/AuditDrawer.tsx
// The in-browser audit-trail viewer (pool-free-e2e-delivery-and-test-plan §F7/§F8). Given a
// settled job, it runs the F7 INDEPENDENT AUDIT in the browser and shows a per-check ✅/❌
// panel: re-hash the Walrus input/output blobs vs the on-chain input_hash/output_hash,
// show the attestation signature + model_hash match, and list the Walrus blob links + the
// Sui object-explorer link. Works against the mock data source too (values synthesized
// consistently so the checks pass, with mock-only fields clearly labelled). Glass-styled
// to match ResultViewer; opens from a My-Jobs row or the ResultViewer "Audit" button.

import { useGix } from "../store";
import { shortId } from "../lib/config";
import type { AuditCheck, BlobRef } from "../trade/audit";

export function AuditDrawer() {
  const { auditingJobId, closeAudit, audits, auditStatus, runJobAudit } = useGix();

  if (!auditingJobId) return null;
  const jobId = auditingJobId;
  const audit = audits[jobId];
  const status = auditStatus[jobId] ?? (audit ? "idle" : "running");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={closeAudit}
    >
      {/* scrim */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-in" />

      <div
        className="glass-base glass-3 relative z-10 flex max-h-[84vh] w-full max-w-2xl animate-slide-in flex-col overflow-hidden rounded-glass"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Independent audit"
      >
        {/* header */}
        <header className="flex shrink-0 items-center justify-between border-b border-border-glass px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-semibold text-primary">
              Independent Audit
            </span>
            <span className="num text-[11px] text-muted" title={jobId}>
              job {shortId(jobId)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {audit && <VerdictBadge ok={audit.ok} />}
            <button
              onClick={closeAudit}
              className="focus-amber rounded p-1 text-muted transition hover:text-primary"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* what this proves */}
          <p className="mb-4 text-[11px] leading-relaxed text-muted">
            The F7 audit re-derives <span className="text-secondary">paid-for-what-was-run</span>{" "}
            from chain + Walrus alone — anyone can run it with no GIX infra. It reads the input
            from the chain (inline in the tx) or the public Walrus aggregator and downloads the
            output blob from Walrus, recomputes <span className="num">sha2_256</span> in your
            browser, and matches them against the on-chain hashes, plus the attestation
            signature and registered <span className="num">model_hash</span>.
          </p>

          {status === "running" && !audit && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-[12px] text-muted">
              <span
                className="h-2 w-2 animate-pulse-dot rounded-full"
                style={{ background: "var(--accent)" }}
              />
              running independent audit…
            </div>
          )}

          {status === "error" && !audit && (
            <div className="flex h-32 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-[12px] text-sell">audit failed to run</p>
              <button
                onClick={() => runJobAudit(jobId)}
                className="focus-amber rounded border border-border-glass px-3 py-1.5 text-[11px] text-accent transition hover:border-accent/50 hover:bg-accent/5"
              >
                Retry
              </button>
            </div>
          )}

          {audit && (
            <>
              {audit.anyMock && (
                <div
                  className="mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[10.5px] leading-relaxed"
                  style={{
                    borderColor: "var(--accent-dim)",
                    background: "var(--accent-dim)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <span className="text-accent">ⓘ</span>
                  <span>
                    Some values are <span className="text-accent">mock</span> — this data
                    source doesn't surface real Walrus blobs / on-chain attestation fields.
                    They're synthesized consistently so the verify still proves out. Run with{" "}
                    <span className="num">VITE_ORDER_CLIENT=sui</span> + a live provider to
                    audit real bytes.
                  </span>
                </div>
              )}

              {/* per-check rows */}
              <div className="space-y-2">
                {audit.checks.map((c) => (
                  <CheckRow key={c.id} c={c} />
                ))}
              </div>

              {/* Walrus blob links */}
              <div className="mt-4 border-t border-border-glass pt-3">
                <span className="label-micro">Walrus blobs</span>
                <div className="mt-1.5 space-y-1.5">
                  {audit.blobs.map((b, i) => (
                    <BlobLink key={`${b.kind}-${i}`} b={b} />
                  ))}
                </div>
              </div>

              {/* explorer link */}
              <div className="mt-3 flex items-center justify-between border-t border-border-glass pt-3">
                <button
                  onClick={() => runJobAudit(jobId)}
                  disabled={status === "running"}
                  className="focus-amber rounded border border-border-glass px-2.5 py-1 text-[10.5px] text-muted transition hover:border-accent/40 hover:text-accent disabled:opacity-60"
                >
                  {status === "running" ? "re-running…" : "↻ re-run audit"}
                </button>
                {audit.explorerUrl ? (
                  <a
                    href={audit.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-accent transition hover:text-accent-strong hover:underline"
                  >
                    View Job on Suiscan
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M7 17L17 7M17 7H8M17 7v9" />
                    </svg>
                  </a>
                ) : (
                  <span className="text-[10.5px] text-muted">
                    explorer link off (localnet / mock)
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VerdictBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        borderColor: ok ? "rgba(46,189,133,0.4)" : "rgba(246,70,93,0.4)",
        color: ok ? "var(--buy)" : "var(--sell)",
        background: ok ? "var(--buy-bg)" : "var(--sell-bg)",
      }}
    >
      {ok ? "✅ Audit passed" : "❌ Audit failed"}
    </span>
  );
}

function CheckRow({ c }: { c: AuditCheck }) {
  const color =
    c.status === "pass"
      ? "var(--buy)"
      : c.status === "fail"
        ? "var(--sell)"
        : "var(--text-muted)";
  const icon = c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "—";
  return (
    <div className="glass rounded-md p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12px] text-primary">
          <span aria-hidden>{icon}</span>
          {c.label}
        </span>
        <span className="flex items-center gap-1.5">
          {c.mock && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
              style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
            >
              mock
            </span>
          )}
          <span className="num text-[10.5px] font-medium uppercase" style={{ color }}>
            {c.status}
          </span>
        </span>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{c.detail}</p>
      {(c.reported || c.computed) && (
        <div className="mt-1.5 space-y-0.5">
          {c.reported && <ProofLine label="on-chain / reported" value={c.reported} />}
          {c.computed && (
            <ProofLine label="recomputed / observed" value={c.computed} color={color} />
          )}
        </div>
      )}
    </div>
  );
}

function ProofLine({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="label-micro shrink-0">{label}</span>
      <span
        className="num truncate text-right text-[10px]"
        style={{ color: color ?? "var(--text-secondary)" }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function BlobLink({ b }: { b: BlobRef }) {
  const label = b.kind === "input" ? "input blob" : "output blob";
  // Option 3 inline-input: the input rides on-chain in the tx (no Walrus blob).
  if (b.onChain) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="label-micro shrink-0">{label}</span>
        <span className="num text-right text-[10.5px] text-secondary">
          on-chain (inline in tx — no Walrus blob)
        </span>
      </div>
    );
  }
  if (b.url) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="label-micro shrink-0">{label}</span>
        <a
          href={b.url}
          target="_blank"
          rel="noreferrer"
          className="num truncate text-right text-[10.5px] text-accent transition hover:text-accent-strong hover:underline"
          title={b.url}
        >
          {b.blobId ? shortId(b.blobId, 8, 6) : b.url}
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="label-micro shrink-0">{label}</span>
      <span className="num text-right text-[10.5px] text-muted">
        {b.mock ? "synthesized (mock — no blob id)" : "no blob id"}
      </span>
    </div>
  );
}
