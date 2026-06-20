/**
 * Failure-injection hooks (§5 failure variants, §4 F5 negative matrix).
 *
 * Each fault is a named transform over the served-job artifacts (and, where relevant, the
 * Walrus store) that produces the on-chain submission the harness should make, PLUS the
 * EXPECTED terminal outcome. The negatives scenario drives every fault and asserts the actual
 * on-chain result matches `expected` — fail-closed: a fault must NEVER end in a provider payout.
 *
 * The faults map 1:1 to the plan's negative matrix:
 *   drop_attestation     → SLA/attest deadline lapses → expire_and_resolve → Refunded(+slash)
 *   corrupt_output       → Walrus output bytes != output_hash → audit hash mismatch (no payout)
 *   forged_signature     → ed25519_verify fails on-chain → submit aborts → no attestation → expire
 *   sla_timeout          → t_end - t_start > market p99 → verdict SLA_BREACH → resolve_attested
 *   node_crash_restart   → idempotency: a 2nd attestation/settle must abort (≤1 record, no double-pay)
 *   walrus_read_fail     → the auditor's Walrus read throws → audit fails → no false settle
 *   wrong_measurement    → non-allowlisted measurement → verdict INVALID → resolve_attested
 */

import type { ServedJob } from "./mock-node.js";
import type { InMemoryWalrus } from "./walrus.js";

/** The terminal outcome a fault is expected to drive. */
export type ExpectedOutcome =
  | "settled" // VALID happy path (not a fault) — provider paid
  | "refunded_slashed" // attestation failed verification → refund + slash
  | "refunded_no_slash" // no-fault refund (e.g. consumer cancel) — not used by the negatives here
  | "expired_refunded" // deadline lapsed, no valid attestation → refund (+slash if provider fault)
  | "submit_aborts" // the attestation tx itself must abort on-chain (e.g. forged sig)
  | "audit_fails"; // settles but the independent audit detects tampering (no false trust)

export type FaultName =
  | "drop_attestation"
  | "corrupt_output"
  | "forged_signature"
  | "sla_timeout"
  | "node_crash_restart"
  | "walrus_read_fail"
  | "wrong_measurement";

export interface FaultPlan {
  name: FaultName;
  /** Whether the harness should still submit an attestation (false ⇒ drop it / expire path). */
  submit: boolean;
  /** The (possibly mutated) served job to submit. */
  served: ServedJob;
  /** The on-chain terminal outcome the harness must assert. */
  expected: ExpectedOutcome;
  /** A human note for the report. */
  note: string;
}

/** Drop the attestation entirely: the provider never attests, the attest deadline lapses, and
 * anyone calls expire_and_resolve → consumer refunded, provider slashed for the miss. */
export function dropAttestation(served: ServedJob): FaultPlan {
  return {
    name: "drop_attestation",
    submit: false,
    served,
    expected: "expired_refunded",
    note: "no attestation submitted; attest deadline lapses → expire_and_resolve refunds + slashes",
  };
}

/** Corrupt the output bytes IN WALRUS after upload so the stored blob no longer hashes to the
 * on-chain output_hash. The on-chain settle still happens (the signature binds the *hash*, not
 * the bytes), but the INDEPENDENT AUDIT detects the tamper → trust is not falsely granted. */
export function corruptOutput(served: ServedJob, walrus: InMemoryWalrus, outputBlobId: bigint): FaultPlan {
  const corrupted = new TextEncoder().encode(served.completion + " <TAMPERED>");
  walrus.corrupt(outputBlobId, corrupted);
  return {
    name: "corrupt_output",
    submit: true,
    served,
    expected: "audit_fails",
    note: "Walrus output bytes mutated post-upload → sha2_256(output) != on-chain output_hash → audit FAILS",
  };
}

/** Forge the signature (flip bytes) so the contract's ed25519_verify rejects → the
 * submit_signed_attestation tx ABORTS (EBadSignature=502). No attestation is recorded. */
export function forgedSignature(served: ServedJob): FaultPlan {
  const sig = Uint8Array.from(served.signature);
  sig[0] ^= 0xff;
  sig[63] ^= 0xff;
  return {
    name: "forged_signature",
    submit: true,
    served: { ...served, signature: sig },
    expected: "submit_aborts",
    note: "signature bytes flipped → on-chain ed25519_verify fails → submit aborts (no payout, no record)",
  };
}

/** Re-stamp the served job so the latency (t_end - t_start) exceeds the market SLA p99, making
 * the on-chain verdict SLA_BREACH → resolve_attested refunds the consumer + slashes. The harness
 * supplies the breaching latency (it knows the market SLA). */
export function slaTimeout(served: ServedJob, breachLatencyMs: number, resign: (s: ServedJob) => ServedJob): FaultPlan {
  const stretched = resign({ ...served, tEnd: served.tStart + breachLatencyMs });
  return {
    name: "sla_timeout",
    submit: true,
    served: stretched,
    expected: "refunded_slashed",
    note: `t_end-t_start=${breachLatencyMs}ms > SLA p99 → verdict SLA_BREACH → resolve_attested refunds + slashes`,
  };
}

/** Wrong runtime measurement (not on the allowlist) → verdict INVALID → resolve_attested. The
 * harness re-serves with the bad measurement so the signature is valid but the binding fails. */
export function wrongMeasurement(served: ServedJob): FaultPlan {
  return {
    name: "wrong_measurement",
    submit: true,
    served, // the harness re-serves with measurementOverride before calling this
    expected: "refunded_slashed",
    note: "measurement not on the allowlist → verdict INVALID → resolve_attested refunds + slashes",
  };
}

/**
 * Node crash + restart idempotency: after a successful attestation+settle, a restarted node
 * re-derives state and attempts to re-submit. The harness asserts the SECOND submit AND the
 * second settle both ABORT (EAlreadyAttested=503 / EBadState=400) — ≤1 AttestationRecord, funds
 * neither lost nor double-paid. This fault is a marker; the harness drives the replay.
 */
export function nodeCrashRestart(served: ServedJob): FaultPlan {
  return {
    name: "node_crash_restart",
    submit: true,
    served,
    expected: "settled", // the FIRST pass settles; the replay must abort (asserted live)
    note: "restart replays attestation+settle; the 2nd of each must abort → exactly-once terminal, no double-pay",
  };
}

/** Walrus read-fail: the auditor cannot fetch the output blob (storage unavailable). The audit
 * must FAIL (cannot prove integrity) rather than falsely report a verified result. The harness
 * marks the blob unreadable before auditing. */
export function walrusReadFail(served: ServedJob, walrus: InMemoryWalrus, outputBlobId: bigint): FaultPlan {
  walrus.failReads(outputBlobId);
  return {
    name: "walrus_read_fail",
    submit: true,
    served,
    expected: "audit_fails",
    note: "Walrus output read forced to fail → audit cannot recompute the hash → reports FAIL (no false trust)",
  };
}
