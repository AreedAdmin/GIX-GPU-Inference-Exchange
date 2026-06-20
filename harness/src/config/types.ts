/**
 * Shared TypeScript types for the GIX M1 harness.
 *
 * Two config surfaces, both BINDING against
 *   docs/mvp-m1-integration-contract.md:
 *   - `Deployment`  mirrors the `deployment.json` schema A's deploy script emits.
 *   - `Scenario`    mirrors the `examples/scenarios/*.json` schema B consumes.
 *
 * Anything the on-chain `gix` package has not finalized yet is flagged in
 * src/chain/INTERFACE_ASSUMPTIONS.md and surfaced through this type layer so the
 * integrator has one place to reconcile.
 */

// ---------------------------------------------------------------------------
// deployment.json  (A → B/C)
// ---------------------------------------------------------------------------

/** One market entry as emitted in deployment.json `markets[]`. */
export interface MarketDeployment {
  /** Shared `Market` object id. */
  id: string;
  /** Human label, e.g. "H100-llama3.1-8b-int8". */
  name: string;
  /** Fully-qualified `Credit<M>` witness type, e.g. `0x..::markets::M_H100_LLAMA8B`. */
  creditType: string;
  /** SCU definition: tokens per 1 SCU (token-metered, decision E1). */
  scuTokens: number;
  /** SLA p99 latency budget in milliseconds. */
  slaP99Ms: number;
  /** Per-market `registry::ModelRecord` id (needed by `submit_mock_attestation`). */
  modelId?: string;
}

/** Named on-chain accounts the harness drives. */
export interface DeploymentAccounts {
  admin: string;
  providers: string[];
  consumers: string[];
}

/**
 * The `deployment.json` document. Mirrors the schema in
 * docs/mvp-m1-integration-contract.md §"A → C/B".
 */
export interface Deployment {
  network: string; // "localnet"
  packageId: string;
  configId: string;
  adminCapId: string;
  /** Fully-qualified MOCK_USDC coin type, e.g. `0x..::mock_usdc::MOCK_USDC`. */
  usdcType: string;
  /** Clock object id, conventionally "0x6". */
  clockId: string;
  /** Shared `settlement::Treasury` id (fee + slash sink). */
  treasuryId?: string;
  /** Shared `registry::MeasurementAllowlist` id. */
  allowlistId?: string;
  /** Shared `mock_usdc::Faucet` id. */
  faucetId?: string;
  /**
   * The exact MOCK-prefixed runtime measurement the deploy allowlisted for the
   * market's model (e.g. "MOCK-tdx-llama8b-v1"). The harness submits exactly this
   * in `submit_mock_attestation`, or every attestation reads INVALID. Surfaced by
   * the deploy script (contracts/scripts/deploy.sh `MOCK_MEASUREMENT`).
   */
  mockMeasurement?: string;
  markets: MarketDeployment[];
  accounts: DeploymentAccounts;
}

// ---------------------------------------------------------------------------
// scenario.json  (C → B)
// ---------------------------------------------------------------------------

/** A numeric distribution the harness samples qty / price / latency from. */
export type Distribution =
  | { kind: "fixed"; value: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "normal"; mean: number; stddev: number; min?: number; max?: number };

/**
 * Fault-injection rates. Each is a probability in [0, 1] that a dispatched job
 * suffers that fault class. They are mutually exclusive per job (resolved in
 * priority order skip → late → wrong); their sum should be ≤ 1.
 *
 * Maps to lifecycle fault transitions (task-lifecycle.md §6):
 *   - skipAttest  → F7 AttTimeout      (missing attestation, 100% bond-share slash)
 *   - lateAttest  → F6 SlaOverrun      (SLA breach, graded 10–50% slash)
 *   - wrongOutput → F8 InvalidAttestation (invalid, 100% bond-share + flat penalty)
 */
export interface FaultRates {
  skipAttest: number;
  lateAttest: number;
  wrongOutput: number;
}

/** Provider behavioral / economic profile for a scenario. */
export interface ProviderProfile {
  count: number;
  /** USDC (6dp, base units) bonded per provider at stake time. */
  bondUsdc: number;
  /** SCU capacity each provider stakes for. */
  capacityScu: number;
  /** SCU credits each provider mints up front per market. */
  mintCreditsScu: number;
}

/** Consumer behavioral profile for a scenario. */
export interface ConsumerProfile {
  count: number;
  /** USDC (6dp, base units) each consumer is faucet-funded with. */
  budgetUsdc: number;
}

/**
 * A scenario config. Mirrors the schema in
 * docs/mvp-m1-integration-contract.md §"B (harness) contract".
 */
export interface Scenario {
  name: string;
  description?: string;
  /** Orders generated per second (the stream rate). */
  orderRatePerSec: number;
  /** Total number of orders to stream before the run stops. */
  orderCount: number;
  providers: ProviderProfile;
  consumers: ConsumerProfile;
  /** Per-order SCU quantity distribution. */
  qtyScu: Distribution;
  /** Per-order price (USDC base units per SCU) distribution. */
  priceUsdcPerScu: Distribution;
  /**
   * Simulated provider execution latency in ms (dry-run drives the SLA check
   * off this; on-chain it informs the mock attestation t_start/t_end window).
   */
  execLatencyMs: Distribution;
  faults: FaultRates;
  /** Deterministic RNG seed for reproducible runs. */
  seed?: number;
}
