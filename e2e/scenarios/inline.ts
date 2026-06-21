/**
 * Inline-input tunnel-free scenario (Option 3, docs/option3-inline-input-interface.md §D).
 *
 * Proves the WHOLE pool-free flow with the prompt carried INLINE on-chain (in `job.input`) and the
 * result delivered via Walrus — so the consumer (Mac) and provider (DGX) never connect over HTTP:
 *
 *   register provider → stake → post_ask
 *   → (consumer) create_job_from_ask carrying `input` = raw prompt bytes, input_blob_id = 0
 *   → assert the on-chain job.input == prompt bytes and sha2_256(job.input) == input_hash
 *   → ack → (mock node) reads the prompt FROM CHAIN (resolveInlinePrompt), NOT the `/inputs` cache
 *   → serve → upload OUTPUT to (in-memory) Walrus → submit signed attestation → settle
 *   → F6 money invariants + F7 audit (input leg recomputes sha2_256(job.input) on-chain; output
 *     leg stays Walrus) all pass
 *   → assert NO HTTP `/inputs` or `/result` call occurred anywhere (the HttpCacheTripwire is
 *     untouched) — the tunnel-free guarantee.
 *
 * Requires the inline-input ABI (create_job_from_ask with an `input` param). On a package that
 * predates it the scenario records a single SKIPPED check explaining the redeploy dependency and
 * returns green (it cannot run, but must not fail the suite on the older deployed package).
 */

import type { E2eChain } from "../chain.js";
import type { MockNode } from "../mock-node.js";
import type { InMemoryWalrus } from "../walrus.js";
import type { Reporter } from "../report.js";
import { auditJob } from "../audit.js";
import { checkAllInvariants, STATE, type Snapshot } from "../invariants.js";
import { ECON, GOLDEN_PROMPTS, escrowFor, BASE_NOW_MS } from "../fixtures/index.js";

export interface InlineCtx {
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runInline(ctx: InlineCtx): Promise<void> {
  const { chain, node, walrus, rep } = ctx;
  const suite = "inline";
  const golden = GOLDEN_PROMPTS.P1;
  const promptBytes = new TextEncoder().encode(golden.prompt);

  // 0. Gate on the inline ABI: an older deployed package has no `input` param. Skip-green there.
  const inlineSupported = await chain.supportsInlineInput();
  if (!inlineSupported) {
    rep.assert(
      suite,
      "inline_abi_available",
      true,
      "SKIPPED — located package predates the inline-input ABI (create_job_from_ask has no `input` param). " +
        "Redeploy the Option-3 contracts (parallel lane) to run the inline scenario.",
    );
    return;
  }
  rep.assert(suite, "inline_abi_available", true, "create_job_from_ask exposes the inline `input` param");

  // 1. Provider register + stake + post_ask.
  const provider = await chain.newFundedActor("provider(inline)");
  const ids = await chain.registerAndStake(provider, {
    attestPubkeyHex: node.attestPubkeyHex,
    bondUsdc: ECON.bondUsdc,
    capacityScu: ECON.capacityScu,
  });
  const { askId } = await chain.postAsk(provider, ids, ECON.askQtyScu, ECON.pricePerScu);
  rep.assert(suite, "ask_posted", !!askId, `ask=${askId}`);

  // 2. Consumer faucet USDC + create_job_from_ask carrying the INLINE input (no Walrus input
  //    upload, no POST /inputs). input_blob_id is pinned to 0 by the contract on this path.
  const consumer = await chain.newFundedActor("consumer(inline)");
  await chain.faucetUsdc(consumer, escrowFor() * 4);

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
    input: promptBytes, // ← the tunnel-free inline payload
  });

  // 3. Assert Dispatched + escrow + the on-chain inline input is the exact prompt bytes, hashed.
  const afterCreate = await chain.jobView(jobId);
  rep.assert(suite, "job_dispatched", afterCreate.state === STATE.DISPATCHED, `state=${afterCreate.state}`);
  rep.assert(suite, "escrow_funded", afterCreate.escrow === BigInt(escrowFor()), `escrow=${afterCreate.escrow} expected=${escrowFor()}`);
  rep.assert(
    suite,
    "inline_input_on_chain",
    bytesEqual(afterCreate.input, promptBytes),
    `chain job.input (${afterCreate.input.length}B) == prompt bytes (${promptBytes.length}B)`,
  );
  rep.assert(
    suite,
    "input_blob_id_zero",
    afterCreate.inputBlobId === 0n,
    `input_blob_id=${afterCreate.inputBlobId} (inline path ⇒ 0, no Walrus input blob)`,
  );
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

  // 4. ack + the node resolves the prompt FROM CHAIN (resolveInlinePrompt) — never the HTTP cache.
  await chain.ack(provider, jobId);
  const resolvedPrompt = node.resolveInlinePrompt({
    jobId,
    input: afterCreate.input,
    inputHashHex: afterCreate.inputHash,
  });
  rep.assert(suite, "node_read_input_from_chain", resolvedPrompt === golden.prompt, `resolved="${resolvedPrompt}"`);

  const served = node.serve({ jobId, prompt: resolvedPrompt, nowMs: ctx.nowMs });
  rep.assert(
    suite,
    "served_output_hash_golden",
    served.outputHash === golden.outputHash,
    `served=${served.outputHash} golden=${golden.outputHash}`,
  );

  // OUTPUT goes to Walrus (provider-paid blob) — NOT the `/result` endpoint.
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

  // 5. Verified → settle.
  const verified = await chain.jobView(jobId);
  rep.assert(suite, "job_verified", verified.state === STATE.VERIFIED, `state=${verified.state}`);

  const { fn } = await chain.settle(provider, jobId, ids.stakeId, verdict);
  rep.assert(suite, "settle_fn", fn === "settle", `fn=${fn}`);

  const afterSettle = await snapshot(chain, provider.address, consumer.address, jobId, ids.stakeId);

  // 6. F6 money invariants over before/after settle (intact: same as the happy path).
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

  // 7. F7 independent audit: INPUT leg recomputes sha2_256(job.input) on-chain (inlineInput),
  //    OUTPUT leg stays Walrus. No input blob is involved (inputBlobId 0n).
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
      inputBlobId: 0n, // inline path: no Walrus input blob
      outputBlobId,
      inlineInput: verified.input, // ← input integrity from the on-chain field
    },
    walrus,
    { expectModelHash: modelHash },
  );
  for (const c of audit.checks) rep.assert(suite, `audit_${c.name}`, c.ok, c.detail);
  rep.assert(suite, "audit_overall", audit.ok, "all F7 checks pass (input on-chain, output on Walrus)");

  // 8. THE tunnel-free assertion: NO `/inputs` or `/result` HTTP call occurred anywhere in the
  //    flow. The HttpCacheTripwire records any access; here it must be pristine.
  const tw = node.httpCache.assertUntouched();
  rep.assert(suite, "no_http_inputs_or_result", tw.ok, tw.detail);
}

/** Re-export so the harness can reuse the default clock. */
export const INLINE_NOW = BASE_NOW_MS;
