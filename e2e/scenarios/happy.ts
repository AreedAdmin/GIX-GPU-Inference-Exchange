/**
 * Happy-path scenario (§5): the full pool-free flow, every invariant asserted inline.
 *
 *   deploy/locate pkg → register provider → stake → post_ask
 *   → (consumer) upload input→Walrus → create_job_from_ask
 *   → assert Escrowed + escrow conservation
 *   → ack → (mock node) serve → upload output→Walrus → submit signed attestation
 *   → assert Verified → settle
 *   → assert provider paid, escrow conserved, exactly-once, no slash
 *   → run F7 audit → assert all hash/sig checks pass
 *
 * Returns nonzero failures via the Reporter; the harness exits nonzero on any.
 */

import type { E2eChain } from "../chain.js";
import type { MockNode } from "../mock-node.js";
import type { InMemoryWalrus } from "../walrus.js";
import type { Reporter } from "../report.js";
import { auditJob } from "../audit.js";
import {
  checkAllInvariants,
  STATE,
  type Snapshot,
} from "../invariants.js";
import { ECON, GOLDEN_PROMPTS, escrowFor, BASE_NOW_MS } from "../fixtures/index.js";

export interface ScenarioCtx {
  chain: E2eChain;
  node: MockNode;
  walrus: InMemoryWalrus;
  rep: Reporter;
  /** Injected clock — never Date.now(). */
  nowMs: number;
}

/** Snapshot the parties' USDC + the job + the stake into one Snapshot for the invariants. */
async function snapshot(chain: E2eChain, providerAddr: string, consumerAddr: string, jobId: string, stakeId: string): Promise<Snapshot> {
  const [providerUsdc, consumerUsdc, treasuryUsdc, job, stake] = await Promise.all([
    chain.usdc(providerAddr),
    chain.usdc(consumerAddr),
    chain.treasuryUsdc(),
    chain.jobView(jobId),
    chain.stakeView(stakeId),
  ]);
  return {
    providerUsdc,
    consumerUsdc,
    treasuryUsdc,
    bond: stake.bond,
    slashedTotal: stake.slashedTotal,
    jobEscrow: job.escrow,
    jobState: job.state,
    jobSlashed: job.slashed,
  };
}

export async function runHappy(ctx: ScenarioCtx): Promise<void> {
  const { chain, node, walrus, rep } = ctx;
  const suite = "happy";
  const golden = GOLDEN_PROMPTS.P1;

  // 1. Provider register + stake + post_ask.
  const provider = await chain.newFundedActor("provider");
  const ids = await chain.registerAndStake(provider, {
    attestPubkeyHex: node.attestPubkeyHex,
    bondUsdc: ECON.bondUsdc,
    capacityScu: ECON.capacityScu,
  });
  const { askId } = await chain.postAsk(provider, ids, ECON.askQtyScu, ECON.pricePerScu);
  rep.assert(suite, "ask_posted", !!askId, `ask=${askId}`);

  // 2. Consumer faucet USDC + upload input to Walrus + create_job_from_ask.
  const consumer = await chain.newFundedActor("consumer");
  await chain.faucetUsdc(consumer, escrowFor() * 4);
  const inputBlobId = await walrus.upload(new TextEncoder().encode(golden.prompt));

  const beforeCreate: Snapshot = {
    providerUsdc: await chain.usdc(provider.address),
    consumerUsdc: await chain.usdc(consumer.address),
    treasuryUsdc: await chain.treasuryUsdc(),
    bond: (await chain.stakeView(ids.stakeId)).bond,
    slashedTotal: 0n,
    jobEscrow: 0n,
    jobState: 0,
    jobSlashed: false,
  };

  const { jobId } = await chain.createJobFromAsk(consumer, {
    askId,
    qtyScu: ECON.jobQtyScu,
    escrowUsdc: escrowFor(),
    inputHashHex: golden.inputHash,
  });

  // 3. Assert Escrowed (Dispatched) + escrow funded + consumer debited exactly the escrow.
  const afterCreate = await chain.jobView(jobId);
  rep.assert(suite, "job_dispatched", afterCreate.state === STATE.DISPATCHED, `state=${afterCreate.state}`);
  rep.assert(suite, "escrow_funded", afterCreate.escrow === BigInt(escrowFor()), `escrow=${afterCreate.escrow} expected=${escrowFor()}`);
  rep.assert(
    suite,
    "input_hash_committed",
    afterCreate.inputHash.toLowerCase() === golden.inputHash.toLowerCase(),
    `chain=${afterCreate.inputHash} golden=${golden.inputHash}`,
  );
  const consumerAfterCreate = await chain.usdc(consumer.address);
  rep.assert(
    suite,
    "consumer_debited_escrow",
    beforeCreate.consumerUsdc - consumerAfterCreate === BigInt(escrowFor()),
    `debited=${beforeCreate.consumerUsdc - consumerAfterCreate}`,
  );

  // 4. ack + serve (deterministic mock node) + upload output to Walrus + submit attestation.
  await chain.ack(provider, jobId);
  const served = node.serve({ jobId, prompt: golden.prompt, nowMs: ctx.nowMs });
  rep.assert(
    suite,
    "served_output_hash_golden",
    served.outputHash === golden.outputHash,
    `served=${served.outputHash} golden=${golden.outputHash}`,
  );
  const outputBlobId = await walrus.upload(new TextEncoder().encode(served.completion));

  const beforeSettle = await snapshot(chain, provider.address, consumer.address, jobId, ids.stakeId);

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
  rep.assert(suite, "verdict_valid", verdict === 0, `verdict=${verdict}`);

  // 5. Assert Verified, then settle.
  const verified = await chain.jobView(jobId);
  rep.assert(suite, "job_verified", verified.state === STATE.VERIFIED, `state=${verified.state}`);

  const { fn } = await chain.settle(provider, jobId, ids.stakeId, verdict);
  rep.assert(suite, "settle_fn", fn === "settle", `fn=${fn}`);

  const afterSettle = await snapshot(chain, provider.address, consumer.address, jobId, ids.stakeId);

  // 6. Money invariants over before/after settle.
  for (const r of checkAllInvariants(beforeSettle, afterSettle, { escrowLocked: BigInt(escrowFor()), feeBps: 0n, verdict })) {
    rep.assert(suite, `invariant_${r.name}`, r.ok, r.detail);
  }
  rep.assert(suite, "job_settled", afterSettle.jobState === STATE.SETTLED, `state=${afterSettle.jobState}`);
  rep.assert(
    suite,
    "provider_paid",
    afterSettle.providerUsdc > beforeSettle.providerUsdc,
    `+${afterSettle.providerUsdc - beforeSettle.providerUsdc}`,
  );
  rep.assert(suite, "not_slashed", !afterSettle.jobSlashed && afterSettle.bond === beforeSettle.bond, "bond unchanged");

  // 7. Exactly-once terminal: a second settle MUST abort.
  let secondSettleAborted = false;
  try {
    await chain.settle(provider, jobId, ids.stakeId, verdict);
  } catch {
    secondSettleAborted = true;
  }
  rep.assert(suite, "second_settle_aborts", secondSettleAborted, "repeat settle on a terminal job must abort");

  // 8. F7 independent audit: read chain + Walrus alone, recompute hashes, verify signature.
  const modelHash = await chain.modelHash();
  const audit = await auditJob(
    {
      jobId,
      inputHash: verified.inputHash,
      outputHash: verified.outputHash,
      modelHash,
      measurement: served.measurement,
      outputTokenCount: served.outputTokenCount,
      tStart: served.tStart,
      tEnd: served.tEnd,
      verdict: 0,
      signature: served.signature,
      attestPubkey: node.attestPubkey,
      inputBlobId,
      outputBlobId,
    },
    walrus,
    { expectModelHash: modelHash },
  );
  for (const c of audit.checks) rep.assert(suite, `audit_${c.name}`, c.ok, c.detail);
  rep.assert(suite, "audit_overall", audit.ok, "all F7 checks pass");
}

/** Re-export so the harness can reuse the default clock. */
export const HAPPY_NOW = BASE_NOW_MS;
