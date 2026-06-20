/**
 * Load / concurrency scenario (§3 L5): N jobs settle INDEPENDENTLY, truly in parallel.
 *
 * Each Job is its own shared object, so settlements don't serialize against each other. To
 * exercise genuine object-parallelism we give each job its OWN (provider, consumer) pair:
 * distinct gas coins, distinct stakes, distinct asks. Nothing owned is shared across the N
 * pipelines, so all N register→stake→post_ask→create→ack→attest→settle flows run concurrently
 * and the fullnode settles them in parallel (sui-move-contracts.md §8 — disjoint settlement
 * atoms). We assert every one reaches Settled with the provider paid and the F7 audit green.
 *
 * (Driving N jobs from ONE provider would force the provider's ack/attest/settle txns to
 * serialize on its single gas coin + shared stake — a Sui owned-object constraint, not a GIX
 * one — which would mask the independence the level is meant to prove. Hence one pair per job.)
 */

import type { E2eChain } from "../chain.js";
import type { MockNode } from "../mock-node.js";
import type { InMemoryWalrus } from "../walrus.js";
import type { Reporter } from "../report.js";
import { auditJob } from "../audit.js";
import { STATE } from "../invariants.js";
import { ECON, GOLDEN_PROMPTS, escrowFor } from "../fixtures/index.js";

export interface LoadCtx {
  chain: E2eChain;
  node: MockNode;
  walrus: InMemoryWalrus;
  rep: Reporter;
  nowMs: number;
  /** Number of concurrent, fully-independent jobs. */
  n: number;
}

/** One fully self-contained pipeline: its own provider + consumer + ask + job. Returns the
 * terminal facts (or throws, captured by Promise.allSettled). */
async function onePipeline(ctx: LoadCtx, i: number): Promise<{ state: number; paid: boolean; auditOk: boolean }> {
  const { chain, node, walrus } = ctx;
  const promptKeys = Object.keys(GOLDEN_PROMPTS) as (keyof typeof GOLDEN_PROMPTS)[];
  const g = GOLDEN_PROMPTS[promptKeys[i % promptKeys.length]!];

  const provider = await chain.newFundedActor(`provider#${i}`);
  const ids = await chain.registerAndStake(provider, {
    attestPubkeyHex: node.attestPubkeyHex,
    bondUsdc: ECON.bondUsdc,
    capacityScu: ECON.capacityScu,
  });
  const { askId } = await chain.postAsk(provider, ids, ECON.jobQtyScu, ECON.pricePerScu);

  const consumer = await chain.newFundedActor(`consumer#${i}`);
  await chain.faucetUsdc(consumer, escrowFor() * 2);
  const inputBlobId = await walrus.upload(new TextEncoder().encode(g.prompt));
  const { jobId } = await chain.createJobFromAsk(consumer, {
    askId,
    qtyScu: ECON.jobQtyScu,
    escrowUsdc: escrowFor(),
    inputHashHex: g.inputHash,
  });

  const providerBefore = await chain.usdc(provider.address);
  await chain.ack(provider, jobId);
  const served = node.serve({ jobId, prompt: g.prompt, nowMs: ctx.nowMs });
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

  const jv = await chain.jobView(jobId);
  const providerAfter = await chain.usdc(provider.address);
  const modelHash = await chain.modelHash();
  const audit = await auditJob(
    { jobId, inputHash: jv.inputHash, outputHash: jv.outputHash, modelHash, measurement: served.measurement, outputTokenCount: served.outputTokenCount, tStart: served.tStart, tEnd: served.tEnd, verdict: 0, signature: served.signature, attestPubkey: node.attestPubkey, inputBlobId, outputBlobId },
    walrus,
    { expectModelHash: modelHash },
  );
  return { state: jv.state, paid: providerAfter > providerBefore, auditOk: audit.ok };
}

export async function runLoad(ctx: LoadCtx): Promise<void> {
  const { rep } = ctx;
  const suite = "load";
  const n = ctx.n;

  // Fire N fully-independent pipelines concurrently — nothing owned is shared across them.
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => onePipeline(ctx, i)));

  let settled = 0;
  let paid = 0;
  let audited = 0;
  let errors = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.state === STATE.SETTLED) settled++;
      if (r.value.paid) paid++;
      if (r.value.auditOk) audited++;
    } else {
      errors++;
      rep.assert(suite, "job_error", false, String(r.reason).slice(0, 200));
    }
  }
  rep.assert(suite, "no_pipeline_errors", errors === 0, `${errors}/${n} pipelines threw`);
  rep.assert(suite, "all_settled_independently", settled === n, `${settled}/${n} reached Settled`);
  rep.assert(suite, "all_providers_paid", paid === n, `${paid}/${n} providers paid`);
  rep.assert(suite, "all_audited", audited === n, `${audited}/${n} passed F7 audit`);
}
