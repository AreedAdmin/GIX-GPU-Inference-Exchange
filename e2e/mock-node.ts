/**
 * The deterministic in-process mock provider node (§5 `--node=mock`).
 *
 * Stands in for the GB10 + Ollama + the node serve loop so L1–L5 run in seconds with NO GPU
 * and NO randomness. It REUSES the node's real attestation primitives — the byte-exact §2
 * canonical message (`node/src/attest/canonical.ts`) and the Ed25519 signer
 * (`node/src/attest/signer.ts`) — so the signature it produces is the SAME one the real node
 * produces and the SAME one the contract's `ed25519_verify` accepts. The only thing mocked is
 * inference: `serve()` returns `mockComplete(prompt)` instead of calling Ollama, so a given
 * prompt always yields the same completion → the same output_hash → the same signature.
 *
 * It also exposes the F7-relevant artifacts (the canonical message bytes, the signature, the
 * pubkey) so the audit verifier and fault hooks can operate on real provider output.
 */

import {
  buildCanonicalMessage,
  sha2_256Hex,
} from "../node/src/attest/canonical.js";
import {
  attestSignerFromSeed,
  type AttestSigner,
} from "../node/src/attest/signer.js";
import {
  MOCK_ATTEST_SEED,
  MOCK_MEASUREMENT,
  mockComplete,
  mockTokenCount,
} from "./fixtures/index.js";

/** Everything the mock node produces for one job — the real signed attestation tuple. */
export interface ServedJob {
  jobId: string;
  measurement: string;
  /** sha2_256(prompt) hex (no 0x). */
  inputHash: string;
  /** sha2_256(completion) hex (no 0x). */
  outputHash: string;
  completion: string;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  /** The byte-exact §2 canonical message that was signed. */
  message: Uint8Array;
  /** 64-byte Ed25519 signature over `message`. */
  signature: Uint8Array;
}

export interface MockNodeOptions {
  /** Fixed Ed25519 attestation seed (default {@link MOCK_ATTEST_SEED}). */
  seed?: Uint8Array;
  /** Runtime measurement string (default {@link MOCK_MEASUREMENT}). */
  measurement?: string;
  /** Fixed serve latency in ms (t_end - t_start). Deterministic; default 222ms. Drive this
   * past the market SLA to deterministically exercise the SLA-breach path. */
  latencyMs?: number;
}

export class MockNode {
  private readonly signer: AttestSigner;
  readonly measurement: string;
  private readonly latencyMs: number;

  constructor(opts: MockNodeOptions = {}) {
    this.signer = attestSignerFromSeed(opts.seed ?? MOCK_ATTEST_SEED);
    this.measurement = opts.measurement ?? MOCK_MEASUREMENT;
    this.latencyMs = opts.latencyMs ?? 222;
  }

  /** The 32-byte Ed25519 attestation pubkey (what register_provider records), 0x-hex. */
  get attestPubkeyHex(): string {
    return "0x" + Buffer.from(this.signer.publicKey).toString("hex");
  }

  get attestPubkey(): Uint8Array {
    return this.signer.publicKey;
  }

  /**
   * Serve one job deterministically: completion = mockComplete(prompt); hashes via sha2_256;
   * t_start/t_end pinned off the injected `nowMs` (NOT Date.now); sign the byte-exact §2
   * message with the fixed Ed25519 key. The result is byte-identical across runs.
   *
   * `measurementOverride` lets a fault scenario serve a non-allowlisted / wrong measurement.
   */
  serve(args: {
    jobId: string;
    prompt: string;
    nowMs: number;
    measurementOverride?: string;
    /** Explicit latency (ms) for this job, overriding the node default. Used by the SLA-breach
     * fault to deterministically push `t_end - t_start` past the market p99. The signature is
     * (re)computed over the breaching t_end, so it is a VALID signature over bad latency — the
     * contract's verdict engine, not signature verification, must reject it. */
    latencyMsOverride?: number;
  }): ServedJob {
    const completion = mockComplete(args.prompt);
    const inputHash = sha2_256Hex(args.prompt);
    const outputHash = sha2_256Hex(completion);
    const measurement = args.measurementOverride ?? this.measurement;
    const tStart = args.nowMs;
    const tEnd = args.nowMs + (args.latencyMsOverride ?? this.latencyMs);
    const outputTokenCount = mockTokenCount(completion);

    const message = buildCanonicalMessage({
      jobId: args.jobId,
      measurement,
      inputHash,
      outputHash,
      outputTokenCount,
      tStart,
      tEnd,
    });
    const signature = this.signer.sign(new Uint8Array(message));

    return {
      jobId: args.jobId,
      measurement,
      inputHash,
      outputHash,
      completion,
      outputTokenCount,
      tStart,
      tEnd,
      message: new Uint8Array(message),
      signature,
    };
  }
}
