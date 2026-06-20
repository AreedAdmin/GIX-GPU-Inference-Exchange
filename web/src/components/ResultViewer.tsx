// web/src/components/ResultViewer.tsx
// The verifiable-result viewer (demo-milestone-contract §3.1). When a bought job reaches
// Attested/Settled, the user opens this glass panel: it shows the ACTUAL model output,
// a verified ✓/✗ (re-hash of output vs the on-chain output_hash), jobId, cost in USDC,
// the provider attestation pubkey, and an explorer link. Matches the Palantir-glass look.

import { useGix } from "../store";
import { shortId } from "../lib/config";
import { fmtUsdc } from "../lib/format";

export function ResultViewer() {
  const {
    viewingJobId,
    closeResult,
    results,
    resultStatus,
    resultErrors,
    fetchResult,
    explorerUrl,
  } = useGix();

  if (!viewingJobId) return null;
  const jobId = viewingJobId;
  const r = results[jobId];
  const status = resultStatus[jobId] ?? (r ? "idle" : "loading");
  const err = resultErrors[jobId];
  const exUrl = explorerUrl(r?.digest);

  const latencyMs = r ? Math.max(0, r.tEnd - r.tStart) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={closeResult}
    >
      {/* scrim */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-in" />

      <div
        className="glass-base glass-3 relative z-10 flex max-h-[82vh] w-full max-w-2xl animate-slide-in flex-col overflow-hidden rounded-glass"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <header className="flex shrink-0 items-center justify-between border-b border-border-glass px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-semibold text-primary">
              Inference Result
            </span>
            <span className="num text-[11px] text-muted" title={jobId}>
              job {shortId(jobId)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {r && <VerifiedBadge ok={r.verified} />}
            <button
              onClick={closeResult}
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
          {status === "loading" && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-[12px] text-muted">
              <span className="h-2 w-2 animate-pulse-dot rounded-full" style={{ background: "var(--accent)" }} />
              fetching result from provider…
            </div>
          )}

          {status === "error" && (
            <div className="flex h-40 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-[12px] text-sell">{err ?? "failed to fetch result"}</p>
              <p className="text-[11px] leading-relaxed text-muted">
                The provider serves <span className="num">/result/:jobId</span> only after
                the job is attested/settled. Retry once it advances.
              </p>
              <button
                onClick={() => fetchResult(jobId)}
                className="focus-amber rounded border border-border-glass px-3 py-1.5 text-[11px] text-accent transition hover:border-accent/50 hover:bg-accent/5"
              >
                Retry
              </button>
            </div>
          )}

          {status === "idle" && r && (
            <>
              {/* model output */}
              <div className="mb-4">
                <span className="label-micro">Model Output · {r.model}</span>
                <pre className="glass mt-1.5 max-h-[34vh] overflow-auto whitespace-pre-wrap rounded-md p-3 text-[12.5px] leading-relaxed text-primary">
                  {r.output}
                </pre>
              </div>

              {/* facts grid */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[11.5px] sm:grid-cols-3">
                <Fact label="Cost" value={r.costUsdc != null ? `${fmtUsdc(r.costUsdc, 4)} USDC` : "—"} />
                <Fact label="Output Tokens" value={r.outputTokenCount.toLocaleString()} mono />
                <Fact label="Latency" value={latencyMs ? `${latencyMs.toLocaleString()} ms` : "—"} mono />
                <Fact label="Job" value={shortId(jobId)} mono title={jobId} />
                <Fact
                  label="Attest Pubkey"
                  value={shortId(r.providerPubkey, 6, 4)}
                  mono
                  title={r.providerPubkey}
                />
                <Fact
                  label="Verified"
                  value={r.verified ? "✓ hash match" : "✗ mismatch"}
                  color={r.verified ? "var(--buy)" : "var(--sell)"}
                />
              </div>

              {/* hash proof */}
              <div className="mt-4 space-y-1.5 border-t border-border-glass pt-3">
                <HashLine label="output_hash · on-chain" value={r.reportedOutputHash} />
                <HashLine
                  label="sha2_256(output) · recomputed"
                  value={r.localOutputHash}
                  color={r.verified ? "var(--buy)" : "var(--sell)"}
                />
                <p className="pt-1 text-[10.5px] leading-relaxed text-muted">
                  The output hash is recorded on-chain in the job's attestation. Re-hashing
                  the returned text and matching it proves the result without trusting the
                  provider's word.
                </p>
              </div>

              {/* explorer link */}
              {exUrl && (
                <div className="mt-3">
                  <a
                    href={exUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-accent transition hover:text-accent-strong hover:underline"
                  >
                    View on-chain payment
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M7 17L17 7M17 7H8M17 7v9" />
                    </svg>
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VerifiedBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        borderColor: ok ? "rgba(14,203,129,0.4)" : "rgba(246,70,93,0.4)",
        color: ok ? "var(--buy)" : "var(--sell)",
        background: ok ? "var(--buy-bg)" : "var(--sell-bg)",
      }}
    >
      {ok ? "✓ Verified" : "✗ Unverified"}
    </span>
  );
}

function Fact({
  label,
  value,
  mono,
  color,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  color?: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="label-micro">{label}</span>
      <span
        className={`text-[12px] ${mono ? "num tabnum" : "font-medium"}`}
        style={{ color: color ?? "var(--text-primary)" }}
      >
        {value}
      </span>
    </div>
  );
}

function HashLine({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="label-micro shrink-0">{label}</span>
      <span
        className="num truncate text-right text-[10.5px]"
        style={{ color: color ?? "var(--text-secondary)" }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
