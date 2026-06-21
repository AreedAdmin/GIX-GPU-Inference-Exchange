# `@gix/e2e` — pool-free end-to-end acceptance harness

The end-to-end acceptance harness for the **pool-free (direct / Ask) path** (docs/pool-free-e2e-delivery-and-test-plan.md §5/§6). It drives the full flow

```
register → stake → post_ask → (consumer) upload input → create_job_from_ask
  → ack → (mock node) serve → upload output → submit_signed_attestation → settle
  → F7 independent audit
```

against a network, **asserting every escrow / attestation / settlement invariant inline** and
**exiting nonzero on any violation** (the CI gate).

## Modes

| flag | values | meaning |
|---|---|---|
| `--net` | `localnet` (default) / `testnet` | network. **testnet is WIRED but guarded OFF** (no testnet spend). |
| `--node` | `mock` (default) / `gb10` | provider. `mock` = deterministic in-process node (no GPU). `gb10` = real qwen — **WIRED, NOT RUN** here. |
| `--scenario` | `happy` (default) / `negatives` / `load` / `all` | which scenario(s) to run. |
| `--n` | int (default 4) | concurrent jobs for the load scenario. |
| `--deploy` | flag | test-publish a fresh ephemeral package (localnet). Off by default — we **locate** the package in `deployment.json` so we never race the running localnet demo. |
| `--deployment` | path | override the deployment json. |
| `--junit` | path | JUnit report output (default `e2e/e2e-report.junit.xml`). |

## Running (localnet, mock node)

Requires a **running localnet with a faucet** (`sui start --force-regenesis --with-faucet`) and a
`deployment.json` whose `packageId` is published on that localnet (chain ids must match). The
harness generates fresh provider/consumer wallets and funds them from the **localnet faucet HTTP**
— it never touches your `sui client` active env/address.

```bash
cd e2e
npm install

npm run e2e:local            # happy path  (≈17s, 22 invariant/audit checks)
npm run e2e:local:negatives  # every fault → its expected refund/slash/no-payout/audit-fail
npm run e2e:local:load       # N independent pipelines settle in parallel
npm run e2e:local:inline     # tunnel-free inline on-chain input (Option 3) — input from chain,
                             # output via Walrus, no /inputs or /result HTTP. Needs the inline ABI;
                             # SKIPS-green on a package that predates create_job_from_ask(input,…).
npm run e2e:local:all        # all four    (happy+negatives+load+inline)

# or directly:
npx tsx harness.ts --net=localnet --node=mock --scenario=all --n=3
```

Exit code is `0` only when every check passed; nonzero (1 = check failed, 2 = guard, 3 = crash).

## Hermetic unit tests (no chain)

The reusable verifiers (`audit.ts`, `invariants.ts`) and the fixtures' determinism contract are
unit-tested with `vitest` — these run in CI with no validator, no Walrus, no network:

```bash
npm test   # e2e/test/audit.test.ts + e2e/test/invariants.test.ts (20 tests)
```

## What each scenario asserts

- **happy** (`scenarios/happy.ts`): job reaches `Dispatched` with the exact escrow funded and the
  consumer debited; the mock node serves the **golden** output hash; attestation verdict `VALID`;
  job reaches `Verified`; `settle` pays the provider `price − fee`, fee → treasury; the four money
  invariants (escrow conservation, no-payout-without-Verified, exactly-once-terminal, no-slash-without-fault);
  a second `settle` aborts; and the **F7 audit** (input/output hash + Ed25519 signature over the
  byte-exact §2 message + model_hash) is green.
- **negatives** (`scenarios/negatives.ts`): one fresh job per fault, each fail-closed (never a payout):
  forged signature → submit aborts on-chain; SLA timeout → `SLA_BREACH` → refund + slash; wrong
  measurement → `INVALID` → refund + slash; corrupt output → settles but the F7 audit detects the
  tamper; Walrus read-fail → audit cannot prove integrity → FAIL; node crash+restart → replayed
  attestation + settle both abort (exactly-once, no double-pay).
- **load** (`scenarios/load.ts`): N fully-independent `(provider, consumer)` pipelines run
  concurrently — disjoint owned objects — proving Sui object-parallel settlement; every job settles
  and audits green.

## How the abstractions work

- **Mock vs gb10 node** (`mock-node.ts`): the mock node REUSES the production node's byte-exact §2
  canonical message (`node/src/attest/canonical.ts`) and Ed25519 signer (`node/src/attest/signer.ts`),
  so its signature is the SAME one the contract's `ed25519_verify` accepts. Only inference is mocked:
  `mockComplete(prompt) = "[gix-mock] echo: " + prompt`, a pure function ⇒ a given prompt always yields
  the same completion → the same output hash → the same signature (no GPU, no randomness, injected
  `nowMs`). The `gb10` mode (real qwen) is wired in the harness but guarded off here.
- **Walrus mock vs real** (`walrus.ts`): Walrus has **no localnet**, so the store is abstracted.
  `InMemoryWalrus` (localnet/CI) is a content-addressed `Map<u256, bytes>` whose ids are
  `sha2_256(bytes)` — a stable commitment exactly like a real Walrus blob id; it also exposes
  `corrupt()` / `failReads()` for fault injection. `RealWalrus` (testnet) wraps the node's `WalrusIO`
  and is never constructed on localnet.

## What ran vs is wired-not-run

| | status |
|---|---|
| localnet + mock node — happy / negatives / load | **RUN green** (40/40 checks, exit 0) |
| e2e hermetic units (audit + invariants) | **RUN green** (20 tests) |
| node/test idempotency + walrus-down | **RUN green** (4 tests) |
| sdk/test audit-verifier + create_job_from_ask | **RUN green** (9 tests) |
| testnet (`--net=testnet`) | **WIRED, guarded OFF** (no testnet spend) |
| real GB10 qwen (`--node=gb10`) | **WIRED, guarded OFF** |
| `RealWalrus` (testnet) | **WIRED, not constructed on localnet** |

The L0/L1 Move suite (`contracts/tests/*`, 66 tests) is the unit/invariant layer this harness
complements at L2–L6; run it with `sui move test` from `contracts/`.

## Layout

```
e2e/
  harness.ts          # orchestrator (modes/networks, guards, JUnit + summary, exit code)
  chain.ts            # live PTB driver (register→stake→post_ask→create_job_from_ask→ack→attest→settle)
  invariants.ts       # money/state invariant checkers (reusable, pure)
  audit.ts            # F7 independent-audit verifier (reusable, pure; lazy ed25519)
  faults.ts           # failure-injection hooks
  mock-node.ts        # deterministic in-process provider (reuses node §2 message + signer)
  walrus.ts           # InMemoryWalrus (localnet) / RealWalrus (testnet) abstraction
  report.ts           # JUnit + human summary
  fixtures/index.ts   # golden prompts/hashes, seeded econ config, injected clock
  scenarios/          # happy.ts, negatives.ts, load.ts
  test/               # hermetic unit tests for audit + invariants
```
