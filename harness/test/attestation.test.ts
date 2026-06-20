import { describe, it, expect } from "vitest";
import {
  buildMockAttestation,
  honestOutputHash,
  predictVerdict,
  MOCK_MEASUREMENT_TAG,
} from "../src/actors/attestation.js";
import { FaultClass } from "../src/orchestrator/model.js";

const base = {
  inputHash: "abc123",
  qtyScu: 4,
  scuTokens: 1000,
  tStart: 1_000_000,
  execLatencyMs: 2000,
};
const SLA = 5000;

describe("mock attestation producer", () => {
  it("emits the canonical mock measurement as hex", () => {
    const att = buildMockAttestation({ ...base, fault: FaultClass.None });
    const decoded = Buffer.from(att.runtimeMeasurement, "hex").toString("utf8");
    expect(decoded).toBe(MOCK_MEASUREMENT_TAG);
  });

  it("binds output_token_count = qty * scuTokens (decision E1)", () => {
    const att = buildMockAttestation({ ...base, fault: FaultClass.None });
    expect(att.outputTokenCount).toBe(4 * 1000);
  });

  it("None → honest hash, will submit, VALID verdict in-SLA", () => {
    const att = buildMockAttestation({ ...base, fault: FaultClass.None });
    expect(att.willSubmit).toBe(true);
    expect(att.outputHash).toBe(honestOutputHash(base.inputHash));
    expect(predictVerdict(att, honestOutputHash(base.inputHash), SLA)).toBe("VALID");
  });

  it("SkipAttest → willSubmit=false (provider never submits)", () => {
    const att = buildMockAttestation({ ...base, fault: FaultClass.SkipAttest });
    expect(att.willSubmit).toBe(false);
  });

  it("WrongOutput → corrupted hash ≠ honest → INVALID verdict", () => {
    const att = buildMockAttestation({ ...base, fault: FaultClass.WrongOutput });
    expect(att.willSubmit).toBe(true);
    expect(att.outputHash).not.toBe(honestOutputHash(base.inputHash));
    expect(predictVerdict(att, honestOutputHash(base.inputHash), SLA)).toBe("INVALID");
  });

  it("LateAttest timing over SLA → SLA_BREACH verdict", () => {
    const att = buildMockAttestation({
      ...base,
      execLatencyMs: SLA + 1000,
      fault: FaultClass.LateAttest,
    });
    expect(att.willSubmit).toBe(true);
    expect(predictVerdict(att, honestOutputHash(base.inputHash), SLA)).toBe("SLA_BREACH");
  });

  it("predictVerdict prioritizes INVALID over SLA_BREACH", () => {
    const att = buildMockAttestation({
      ...base,
      execLatencyMs: SLA + 5000,
      fault: FaultClass.WrongOutput,
    });
    // both wrong-output AND late, but INVALID wins
    expect(predictVerdict(att, honestOutputHash(base.inputHash), SLA)).toBe("INVALID");
  });
});
