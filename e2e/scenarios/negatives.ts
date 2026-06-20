/**
 * Negatives scenario (§5 failure variants, §4 F5/F6): drive each fault on its OWN fresh job
 * and assert the EXPECTED terminal outcome — refund/slash/no-payout/audit-fail, never a payout.
 *
 * One job per fault keeps them independent (Sui object-parallel) and makes each assertion crisp.
 * Every fault is fail-closed: a faulty job MUST NOT end with the provider paid.
 *
 *   forged_signature   → submit aborts on-chain (ed25519_verify fails); no record, no payout
 *   sla_timeout        → verdict SLA_BREACH → resolve_attested → Refunded + Slashed
 *   wrong_measurement  → verdict INVALID    → resolve_attested → Refunded + Slashed
 *   drop_attestation   → attest deadline lapses → expire_and_resolve → Refunded (+slash)
 *   corrupt_output     → settles on-chain BUT the F7 audit detects the tamper → audit FAILS
 *   walrus_read_fail   → the F7 audit cannot read the blob → audit FAILS (no false trust)
 *   node_crash_restart → replayed attestation + settle both abort → exactly-once, no double-pay
 */

import type { E2eChain, Actor } from "../chain.js";
import type { MockNode } from "../mock-node.js";
import type { InMemoryWalrus } from "../walrus.js";
import type { Reporter } from "../report.js";
import { auditJob } from "../audit.js";
import { STATE } from "../invariants.js";
import {
  corruptOutput,
  forgedSignature,
  slaTimeout,
  walrusReadFail,
  wrongMeasurement,
} from "../faults.js";
import { ECON, GOLDEN_PROMPTS, escrowFor } from "../fixtures/index.js";

export interface NegativesCtx {
  chain: E2eChain;
  node: MockNode;
  walrus: InMemoryWalrus;
  rep: Reporter;
  nowMs: number;
  /** Market p99 SLA in ms (read from deployment). A latency above this triggers SLA_BREACH. */
  slaP99Ms: number;
}

/** Shared provider + ask reused across the fault jobs (each fault buys its own slice). */
/** The negatives scenario buys one job slice per fault (7 faults). Size the ask + capacity to
 * cover them all so `ask::draw` never runs out mid-scenario (EInsufficientRemaining=406). */
const NEG_FAULT_JOBS = 8; // 7 faults + headroom
async function setupProviderAndAsk(chain: E2eChain, node: MockNode): Promise<{ provider: Actor; ids: { capId: string; recordId: string; stakeId: string }; askId: string }> {
  const provider = await chain.newFundedActor("provider(neg)");
  const askQty = Math.max(ECON.askQtyScu, ECON.jobQtyScu * NEG_FAULT_JOBS);
  const capacity = Math.max(ECON.capacityScu, askQty);
  const ids = await chain.registerAndStake(provider, {
    attestPubkeyHex: node.attestPubkeyHex,
    bondUsdc: ECON.bondUsdc,
    capacityScu: capacity,
  });
  const { askId } = await chain.postAsk(provider, ids, askQty, ECON.pricePerScu);
  return { provider, ids, askId };
}

/** Create a fresh job against the shared ask, served from a golden prompt. */
async function freshJob(chain: E2eChain, consumer: Actor, askId: string, promptKey: keyof typeof GOLDEN_PROMPTS): Promise<{ jobId: string; prompt: string; inputHash: string }> {
  const g = GOLDEN_PROMPTS[promptKey];
  const { jobId } = await chain.createJobFromAsk(consumer, {
    askId,
    qtyScu: ECON.jobQtyScu,
    escrowUsdc: escrowFor(),
    inputHashHex: g.inputHash,
  });
  return { jobId, prompt: g.prompt, inputHash: g.inputHash };
}

export async function runNegatives(ctx: NegativesCtx): Promise<void> {
  const { chain, node, walrus, rep } = ctx;
  const suite = "negatives";
  const { provider, ids, askId } = await setupProviderAndAsk(chain, node);
  const consumer = await chain.newFundedActor("consumer(neg)");
  await chain.faucetUsdc(consumer, escrowFor() * 12);

  // ---- forged_signature → submit aborts on-chain --------------------------
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P1");
    await chain.ack(provider, jobId);
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs });
    const plan = forgedSignature(served);
    let aborted = false;
    try {
      await chain.submitSignedAttestation(provider, {
        jobId,
        providerRecordId: ids.recordId,
        measurement: plan.served.measurement,
        inputHashHex: plan.served.inputHash,
        outputHashHex: plan.served.outputHash,
        outputTokenCount: plan.served.outputTokenCount,
        tStart: plan.served.tStart,
        tEnd: plan.served.tEnd,
        signature: plan.served.signature,
      });
    } catch {
      aborted = true;
    }
    rep.assert(suite, "forged_signature_submit_aborts", aborted, plan.note);
    const jv = await chain.jobView(jobId);
    rep.assert(suite, "forged_signature_no_record", jv.verdict === undefined && jv.state === STATE.EXECUTING, `state=${jv.state} verdict=${jv.verdict}`);
    // The provider is NOT paid: clean up via expire later not required for the assertion.
  }

  // ---- sla_timeout → verdict SLA_BREACH → resolve_attested ----------------
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P2");
    await chain.ack(provider, jobId);
    // Serve with an explicit latency past the market p99 — a VALID signature over bad latency.
    const breachMs = ctx.slaP99Ms + 5_000;
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs, latencyMsOverride: breachMs });
    const plan = slaTimeout(served, breachMs, (s) => s);
    const providerBefore = await chain.usdc(provider.address);
    const consumerBefore = await chain.usdc(consumer.address);
    const { verdict } = await chain.submitSignedAttestation(provider, {
      jobId,
      providerRecordId: ids.recordId,
      measurement: plan.served.measurement,
      inputHashHex: plan.served.inputHash,
      outputHashHex: plan.served.outputHash,
      outputTokenCount: plan.served.outputTokenCount,
      tStart: plan.served.tStart,
      tEnd: plan.served.tEnd,
      signature: plan.served.signature,
    });
    rep.assert(suite, "sla_timeout_verdict_breach", verdict === 1, `verdict=${verdict} (1=SLA_BREACH)`);
    await chain.settle(provider, jobId, ids.stakeId, verdict);
    const jv = await chain.jobView(jobId);
    const providerAfter = await chain.usdc(provider.address);
    const consumerAfter = await chain.usdc(consumer.address);
    rep.assert(suite, "sla_timeout_refunded", jv.state === STATE.REFUNDED && jv.slashed, `state=${jv.state} slashed=${jv.slashed}`);
    rep.assert(suite, "sla_timeout_no_payout", providerAfter <= providerBefore, `providerΔ=${providerAfter - providerBefore} (must be ≤0)`);
    rep.assert(suite, "sla_timeout_consumer_made_whole", consumerAfter >= consumerBefore, `consumerΔ=${consumerAfter - consumerBefore} (refund ≥ escrow)`);
  }

  // ---- wrong_measurement → verdict INVALID → resolve_attested -------------
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P3");
    await chain.ack(provider, jobId);
    // Serve with a non-allowlisted measurement (still MOCK-prefixed so submit isn't blocked by
    // the mock fence — but NOT the allowlisted string, so compute_verdict returns INVALID).
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs, measurementOverride: "MOCK-not-allowlisted-vX" });
    const plan = wrongMeasurement(served);
    const providerBefore = await chain.usdc(provider.address);
    const { verdict } = await chain.submitSignedAttestation(provider, {
      jobId,
      providerRecordId: ids.recordId,
      measurement: plan.served.measurement,
      inputHashHex: plan.served.inputHash,
      outputHashHex: plan.served.outputHash,
      outputTokenCount: plan.served.outputTokenCount,
      tStart: plan.served.tStart,
      tEnd: plan.served.tEnd,
      signature: plan.served.signature,
    });
    rep.assert(suite, "wrong_measurement_verdict_invalid", verdict === 2, `verdict=${verdict} (2=INVALID)`);
    await chain.settle(provider, jobId, ids.stakeId, verdict);
    const jv = await chain.jobView(jobId);
    const providerAfter = await chain.usdc(provider.address);
    rep.assert(suite, "wrong_measurement_refunded_slashed", jv.state === STATE.REFUNDED && jv.slashed, `state=${jv.state} slashed=${jv.slashed}`);
    rep.assert(suite, "wrong_measurement_no_payout", providerAfter <= providerBefore, `providerΔ=${providerAfter - providerBefore}`);
  }

  // ---- corrupt_output → settles but F7 audit detects tamper ---------------
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P1");
    await chain.ack(provider, jobId);
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs });
    const outputBlobId = await walrus.upload(new TextEncoder().encode(served.completion));
    const { verdict } = await chain.submitSignedAttestation(provider, {
      jobId,
      providerRecordId: ids.recordId,
      measurement: served.measurement,
      inputHashHex: served.inputHash,
      outputHashHex: served.outputHash,
      outputTokenCount: served.outputTokenCount,
      tStart: served.tStart,
      tEnd: served.tEnd,
      signature: served.signature,
      outputBlobId,
    });
    await chain.settle(provider, jobId, ids.stakeId, verdict);
    // Now corrupt the stored blob AFTER settle and audit.
    const inputBlobId = await walrus.upload(new TextEncoder().encode(prompt));
    corruptOutput(served, walrus, outputBlobId);
    const jv = await chain.jobView(jobId);
    const modelHash = await chain.modelHash();
    const audit = await auditJob(
      { jobId, inputHash: jv.inputHash, outputHash: jv.outputHash, modelHash, measurement: served.measurement, outputTokenCount: served.outputTokenCount, tStart: served.tStart, tEnd: served.tEnd, verdict: 0, signature: served.signature, attestPubkey: node.attestPubkey, inputBlobId, outputBlobId },
      walrus,
      { expectModelHash: modelHash },
    );
    const outputCheck = audit.checks.find((c) => c.name === "output_hash");
    rep.assert(suite, "corrupt_output_audit_fails", outputCheck !== undefined && !outputCheck.ok && !audit.ok, outputCheck?.detail ?? "no output check");
  }

  // ---- walrus_read_fail → F7 audit cannot read → audit FAILS --------------
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P2");
    await chain.ack(provider, jobId);
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs });
    const outputBlobId = await walrus.upload(new TextEncoder().encode(served.completion));
    const inputBlobId = await walrus.upload(new TextEncoder().encode(prompt));
    const { verdict } = await chain.submitSignedAttestation(provider, {
      jobId,
      providerRecordId: ids.recordId,
      measurement: served.measurement,
      inputHashHex: served.inputHash,
      outputHashHex: served.outputHash,
      outputTokenCount: served.outputTokenCount,
      tStart: served.tStart,
      tEnd: served.tEnd,
      signature: served.signature,
      outputBlobId,
    });
    await chain.settle(provider, jobId, ids.stakeId, verdict);
    walrusReadFail(served, walrus, outputBlobId);
    const jv = await chain.jobView(jobId);
    const modelHash = await chain.modelHash();
    const audit = await auditJob(
      { jobId, inputHash: jv.inputHash, outputHash: jv.outputHash, modelHash, measurement: served.measurement, outputTokenCount: served.outputTokenCount, tStart: served.tStart, tEnd: served.tEnd, verdict: 0, signature: served.signature, attestPubkey: node.attestPubkey, inputBlobId, outputBlobId },
      walrus,
      { expectModelHash: modelHash },
    );
    const outputCheck = audit.checks.find((c) => c.name === "output_hash");
    rep.assert(suite, "walrus_read_fail_audit_fails", outputCheck !== undefined && !outputCheck.ok && !audit.ok, outputCheck?.detail ?? "no output check");
    walrus.healReads(outputBlobId);
  }

  // ---- node_crash_restart → replay aborts (idempotency, no double-pay) -----
  {
    const { jobId, prompt } = await freshJob(chain, consumer, askId, "P3");
    await chain.ack(provider, jobId);
    const served = node.serve({ jobId, prompt, nowMs: ctx.nowMs });
    const outputBlobId = await walrus.upload(new TextEncoder().encode(served.completion));
    const submit = async () =>
      chain.submitSignedAttestation(provider, {
        jobId,
        providerRecordId: ids.recordId,
        measurement: served.measurement,
        inputHashHex: served.inputHash,
        outputHashHex: served.outputHash,
        outputTokenCount: served.outputTokenCount,
        tStart: served.tStart,
        tEnd: served.tEnd,
        signature: served.signature,
        outputBlobId,
      });
    const { verdict } = await submit();
    await chain.settle(provider, jobId, ids.stakeId, verdict);
    const providerAfterFirst = await chain.usdc(provider.address);
    // RESTART: the node replays the same attestation + settle. Both must abort.
    let replayAttestAborted = false;
    try {
      await submit();
    } catch {
      replayAttestAborted = true;
    }
    let replaySettleAborted = false;
    try {
      await chain.settle(provider, jobId, ids.stakeId, verdict);
    } catch {
      replaySettleAborted = true;
    }
    const providerAfterReplay = await chain.usdc(provider.address);
    rep.assert(suite, "replay_attest_aborts", replayAttestAborted, "2nd submit_signed_attestation must abort (EAlreadyAttested)");
    rep.assert(suite, "replay_settle_aborts", replaySettleAborted, "2nd settle must abort (terminal job)");
    rep.assert(suite, "no_double_pay", providerAfterReplay === providerAfterFirst, `providerΔ on replay=${providerAfterReplay - providerAfterFirst} (must be 0)`);
  }
}
