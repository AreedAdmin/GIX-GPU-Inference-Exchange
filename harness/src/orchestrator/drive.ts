/**
 * Bridges a JobRecord + scenario sampling into a concrete MockAttestation,
 * forcing the timing window per the injected fault so the on-chain SLA check
 * (and the dry-run verdict) produce the intended terminal state.
 */

import { buildMockAttestation, type MockAttestation } from "../actors/attestation.js";
import { FaultClass, type JobRecord } from "./model.js";

export interface DriveCtx {
  scuTokens: number;
  slaP99Ms: number;
  /** Samples a base execution latency (ms) from the scenario distribution. */
  execLatency: () => number;
}

export function makeMockAttestationForJob(job: JobRecord, ctx: DriveCtx): MockAttestation {
  let execMs = Math.max(1, ctx.execLatency());

  // LateAttest must breach the SLA: clamp the latency to strictly above p99.
  if (job.fault === FaultClass.LateAttest) {
    execMs = Math.max(execMs, ctx.slaP99Ms + 1);
  } else if (job.fault === FaultClass.None || job.fault === FaultClass.WrongOutput) {
    // Honest/wrong-output runs should be in-SLA so the *only* fault is the one
    // injected (wrong output), not an accidental SLA breach from a fat tail.
    execMs = Math.min(execMs, ctx.slaP99Ms);
  }

  return buildMockAttestation({
    inputHash: job.inputHash,
    qtyScu: job.qtyScu,
    scuTokens: ctx.scuTokens,
    tStart: job.tStart,
    execLatencyMs: execMs,
    fault: job.fault,
  });
}
