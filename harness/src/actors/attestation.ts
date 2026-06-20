/**
 * Mock-attestation producer.
 *
 * In M1 the on-chain verifier is a dev-only mock (`gix::submit_mock_attestation`,
 * isolated per decision K4) that accepts a synthetic `runtime_measurement` +
 * `output_hash` + timing window instead of a real Intel-TDX P-256 quote. This
 * module produces the bytes/values that mock verifier accepts, and bends them
 * per the scenario's fault injection so the harness can drive the slash paths.
 *
 * ASSUMPTION (flagged in INTERFACE_ASSUMPTIONS.md): the exact mock measurement
 * the contract allowlists. We emit the canonical sentinel `MOCK-MEASUREMENT-V1`;
 * integration must confirm the contract's mock allowlist key.
 */

import { createHash } from "node:crypto";
import { FaultClass } from "../orchestrator/model.js";

/** The sentinel runtime measurement the M1 mock verifier is expected to accept. */
export const MOCK_MEASUREMENT_TAG = "MOCK-MEASUREMENT-V1";

/** Values fed into `submit_mock_attestation`, plus harness-side intent. */
export interface MockAttestation {
  /** `runtime_measurement: vector<u8>` — sentinel measurement bytes (hex). */
  runtimeMeasurement: string;
  /** `output_hash: vector<u8>` (hex). Deliberately corrupted on WrongOutput. */
  outputHash: string;
  /** `output_token_count: u64` — binds the metered SCU output (decision E1). */
  outputTokenCount: number;
  /** `t_start: u64` (ms epoch). */
  tStart: number;
  /** `t_end: u64` (ms epoch). */
  tEnd: number;
  /** Whether the harness intends to actually submit (false on SkipAttest). */
  willSubmit: boolean;
}

/** Deterministic hex digest helper (BLAKE-style stand-in; sha256 in M1). */
export function hashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The honest output hash a correct run would produce: a function of the input
 * commitment and the canonical "synthetic model output" for that input.
 */
export function honestOutputHash(inputHash: string): string {
  return hashHex(`gix-mock-output|${inputHash}`);
}

export interface BuildArgs {
  inputHash: string;
  qtyScu: number;
  /** SCU token multiplier from the market (1 SCU = N tokens, E1). */
  scuTokens: number;
  tStart: number;
  /** Simulated execution latency in ms. */
  execLatencyMs: number;
  fault: FaultClass;
}

/**
 * Build the mock attestation for a job, honoring the injected fault:
 *
 *   - None        → honest measurement + correct output hash, in-SLA timing.
 *   - SkipAttest  → willSubmit=false (provider never submits → AttTimeout slash).
 *   - LateAttest  → honest values, but t_end − t_start exceeds SLA (SlaOverrun).
 *   - WrongOutput → corrupted output hash (InvalidAttestation slash).
 *
 * Note: LateAttest still SUBMITS; the on-chain SLA check (t_end − t_start vs
 * Market.sla) is what produces the SLA_BREACH verdict. The caller passes the
 * scenario's execLatencyMs, which for LateAttest is forced over the SLA.
 */
export function buildMockAttestation(args: BuildArgs): MockAttestation {
  const measurement = Buffer.from(MOCK_MEASUREMENT_TAG, "utf8").toString("hex");
  const honest = honestOutputHash(args.inputHash);
  const outputTokenCount = args.qtyScu * args.scuTokens;

  switch (args.fault) {
    case FaultClass.SkipAttest:
      return {
        runtimeMeasurement: measurement,
        outputHash: honest,
        outputTokenCount,
        tStart: args.tStart,
        tEnd: args.tStart + args.execLatencyMs,
        willSubmit: false,
      };
    case FaultClass.WrongOutput:
      return {
        runtimeMeasurement: measurement,
        // Corrupt the output hash so the on-chain hash-binding check fails.
        outputHash: hashHex(`WRONG|${honest}`),
        outputTokenCount,
        tStart: args.tStart,
        tEnd: args.tStart + args.execLatencyMs,
        willSubmit: true,
      };
    case FaultClass.LateAttest:
    case FaultClass.None:
    default:
      return {
        runtimeMeasurement: measurement,
        outputHash: honest,
        outputTokenCount,
        tStart: args.tStart,
        tEnd: args.tStart + args.execLatencyMs,
        willSubmit: true,
      };
  }
}

/**
 * Decide the verdict the on-chain mock verifier would reach, given the SLA
 * budget. Used by dry-run to drive settlement and (on chain) to predict the
 * effect we reconcile against emitted events.
 *
 * Returns one of: "VALID" | "SLA_BREACH" | "INVALID".
 */
export function predictVerdict(
  att: MockAttestation,
  expectedOutputHash: string,
  slaP99Ms: number,
): "VALID" | "SLA_BREACH" | "INVALID" {
  if (att.outputHash !== expectedOutputHash) return "INVALID";
  if (att.tEnd - att.tStart > slaP99Ms) return "SLA_BREACH";
  return "VALID";
}
