# Pool-free end-to-end delivery & rigorous test plan

**Status:** Plan + scaffold spec. **Goal:** deliver GIX **end-to-end on testnet via the
direct/Ask path — with no DeepBook permissionless pool** — so the project is fully
demonstrable even if we never obtain test DEEP / enough SUI. **Quote dollar = MOCK_USDC**
(we control its mint → zero swap friction). The DeepBook order book is a strictly *additive*
layer added later via `set_deepbook_pool_id`; nothing here is throwaway.

This doc is the source of truth for the contingency build and its testing. It (1) defines the
pool-free architecture, (2) inventories features + status, (3) defines the **test taxonomy
(the rigorous testing environment)**, (4) gives **per-feature implementation scaffold + test
strategy + the concrete checking algorithms**, (5) specifies the **E2E acceptance harness**.

---

## 1. Pool-free architecture (what changes vs. the pool version)

Only **matching** changes. The provider posts a resting **`Ask<M>`** (`staking::post_ask`)
and the consumer fills it with **`job::create_job_from_ask`** — instead of a DeepBook
fill → `create_job_from_fill`. Everything downstream is identical.

```
Provider: register → stake(Balance<MOCK_USDC>) → mint_credits → post_ask(price, qty)
Consumer: faucet MOCK_USDC → upload input→Walrus → create_job_from_ask(credits-from-ask, input_blob, input_hash)
          → Job(Escrowed) → dispatch event
Node(GB10): read input(Walrus) → run qwen → write output(Walrus) → submit_signed_attestation
Contract:  verify(soft Ed25519) → settle: pay provider / refund / slash; AttestationRecord retained
Consumer:  fetch output(Walrus) → recompute sha2_256 → compare on-chain output_hash  ✅ audit
```

Invariant: the pool-free path reuses the **same** escrow/attestation/settlement/Walrus code
as the pool path — so testing it validates ~90% of the pool path too.

---

## 2. Feature inventory & status

| # | Feature | Modules | Status | Pool-free gap |
|---|---|---|---|---|
| F1 | Provider lifecycle (register/stake/mint/ask) | `registry`,`staking` | built | testnet run + tests |
| F2 | Consumer buy — **direct/Ask** | `job::create_job_from_ask`,`escrow` | built (E1) | testnet wiring + tests |
| F3 | Dispatch + serve (GB10 + qwen) | `node/` | built | testnet mode run |
| F4 | Walrus I/O (input/output blobs) | `node`,`sdk`,`job` | **live** ✅ | wire into the live run |
| F5 | Attestation (soft Ed25519) | `attestation`,`node` | built (D1) | negative-test matrix |
| F6 | Settlement (verify→pay/refund/slash) | `settlement`,`slashing` | built | invariant + failure tests |
| F7 | Audit / verification (hash, reconstruct) | `sdk`,`web` | partial | verifier + UI viewer |
| F8 | UI (market, Trade/Run, result, audit) | `web/` | built | audit viewer + testnet wiring |
| F9 | OpenAI-compatible gateway | `services/gateway` | built (D2) | testnet run (optional) |

**Deliverable:** F1–F8 running live on testnet via the direct path, each with the test rigor in §4.

---

## 3. Test taxonomy — the rigorous testing environment

Six levels, two environments, deterministic where possible.

| Level | What | Where | Tool |
|---|---|---|---|
| **L0 Unit** | pure functions (hashing, pricing, encoding, state math) | local | `sui move test`, vitest |
| **L1 Invariant** | economic/state invariants via multi-party `test_scenario` | localnet | `sui move test` |
| **L2 Integration** | multi-component flows (contract+sdk+Walrus+node) | localnet→testnet | TS harness (vitest) |
| **L3 Failure / chaos** | fault & adversarial scenarios → correct refund/slash | localnet→testnet | TS harness + fault hooks |
| **L4 Property / fuzz** | randomized job sequences & inputs vs. invariants | localnet | TS + Move generators |
| **L5 Load / concurrency** | N parallel jobs settle independently (Sui object-parallel) | localnet/testnet | TS harness |
| **L6 E2E acceptance** | the full pool-free flow + every invariant asserted | testnet (real GB10) | `e2e/` orchestrator |

**Environments**
- **localnet** — fast, ephemeral (`sui client test-publish --build-env localnet`); the CI default; a **deterministic mock node** (no GPU) for L1–L5 so loops are seconds, not minutes.
- **testnet** — real network + **real GB10 node serving qwen** for L2/L3/L6 acceptance.
- **Determinism rule:** seed all PRNGs; pin clocks via the Move `Clock` test handle and a harness `nowMs` injector; fixed model + fixed prompts → fixed hashes in golden fixtures.

---

## 4. Per-feature: scaffold + test strategy + checking algorithms

### F1 — Provider lifecycle
- **Tests:** L0 capacity math; L1 *no-over-mint*; L2 register→stake→mint→ask on chain.
- **Algorithm — no-over-mint invariant:** after every `mint_credits`, assert
  `minted_credits_outstanding ≤ floor(stake_bond / k_ratio / scu_price_ref)` (capacity ceiling);
  a mint that would exceed it must abort. Property-test with random stake/mint sequences.

### F2 — Consumer buy (direct/Ask)
- **Tests:** L1 ask↔credit conservation; L2 `create_job_from_ask` → `Job(Escrowed)`; L3 buy against a stale/withdrawn ask → clean abort, no escrow lost.
- **Algorithm — ask consumption:** `filled_qty ≤ ask_qty`; partial fill leaves `ask_qty - filled` resting; double-fill of the same ask slice aborts.

### F3 — Dispatch + serve
- **Tests:** L2 dispatch event → node picks up → serves; L3 node crash mid-serve (idempotency); L5 N concurrent jobs.
- **Algorithm — idempotency/replay:** node keys work by `job_id`; on restart it re-derives state from chain events and **never double-submits** an attestation (assert: ≤1 `AttestationRecord` per job; funds neither lost nor double-paid).

### F4 — Walrus I/O *(live)*
- **Tests:** L0 blob_id↔u256 round-trip; L2 upload→download→hash-verify on testnet; L3 Walrus-unavailable → job does not falsely settle.
- **Algorithm — content integrity:** store `h = sha2_256(bytes)` on-chain; retrieval recomputes `h'` and asserts `h' == h`. blob_id is retrieval-only (a commitment), **never** the integrity primitive.

### F5 — Attestation (soft Ed25519)
- **Tests:** L1 happy verify; **L3 negative matrix** (the core rigor): each row must yield reject + correct refund/slash, never payout.
- **Algorithm — negative matrix (must all fail closed):**
  | mutation | expected |
  |---|---|
  | forged/invalid signature | reject, no payout |
  | unregistered signer key | reject |
  | wrong runtime measurement | reject |
  | `model_hash` mismatch | reject |
  | `input_hash`/`output_hash` mismatch | reject |
  | stale / replayed quote (nonce/job reuse) | reject |
  | `t_end - t_start > SLA` | settle as SLA-breach → slash/refund |
  Canonical message bound exactly: `"GIX_ATTEST_V1" ‖ job_id ‖ measurement ‖ input_hash ‖ output_hash ‖ u64le(tokens) ‖ u64le(t_start) ‖ u64le(t_end)`.

### F6 — Settlement
- **Tests:** L1 the **money invariants** (below); L3 refund/slash/expire paths; L4 random lifecycle fuzz.
- **Algorithms — money invariants (assert after *every* op):**
  1. **Escrow conservation:** `Σ escrow_locked == Σ paid_to_provider + Σ refunded_to_consumer + Σ slashed`. No mint/burn of USDC outside these.
  2. **No payout without `Verified`:** a transition that pays the provider requires state `Verified`; from any non-Verified state, payout is unreachable.
  3. **Exactly-once terminal:** each `Job` reaches exactly one of {Settled, Refunded, Slashed, Expired}; a second settlement attempt aborts.
  4. **No slash without fault:** slashing requires a proven fault (missed deadline / failed verify); a correctly-served job is never slashed.
  - **Method:** snapshot all balances + job state before/after each op in the harness; diff and assert (1)–(4). Property-test over random op sequences (L4).

### F7 — Audit / verification
- **Tests:** L2 reconstruct-from-chain-and-Walrus-alone (relayer + node offline); L0 verifier unit tests.
- **Algorithm — independent audit (the trust-minimization proof):**
  ```
  given job_id:
    read Job + AttestationRecord from Sui   (input_hash, output_hash, model_hash, blob ids, verdict)
    fetch input_bytes, output_bytes from Walrus by blob_id (via public aggregator)
    assert sha2_256(input_bytes)  == input_hash
    assert sha2_256(output_bytes) == output_hash
    assert attestation signature verifies over the canonical message
    assert model_hash == registered ModelRecord.model_hash
  ⇒ "paid-for-what-was-run" is provable by anyone, with no GIX infra running.
  ```

### F8 — UI
- **Tests:** L0 component/format tests; an **in-browser audit viewer** that runs the F7 algorithm against a settled job and shows ✅/❌ per check; Run-tab empty-state.
- **Scaffold:** `AuditDrawer` — given a job, list its Walrus blob links + live hash-verify badges.

### F9 — Gateway (optional)
- **Tests:** L2 OpenAI-compatible request → buy(direct) → serve → response; assert response shape + that settlement occurred.

---

## 5. E2E acceptance harness (`e2e/`)

One TypeScript orchestrator, two modes, all invariants asserted inline.

- **Modes:** `--node=mock` (deterministic, no GPU — CI/L1–L5) and `--node=gb10` (real qwen — L6 acceptance).
- **Networks:** `--net=localnet` (default, ephemeral) and `--net=testnet`.
- **Flow + assertions (happy path):** deploy/locate pkg → register provider → stake → mint → post_ask → (consumer) upload input→Walrus → create_job_from_ask → assert `Escrowed` + escrow conservation → dispatch → serve → write output→Walrus → submit attestation → assert `Verified` → settle → assert provider paid, escrow conserved, exactly-once → run **F7 audit** → assert all hash/sig checks pass.
- **Failure variants (each its own assertion):** drop attestation (→ expire+refund); corrupt output bytes (→ hash mismatch → no payout); forged signature; SLA timeout; node crash+restart (idempotency); Walrus read fail (no false settle).
- **Outputs:** a JUnit-style report + a human summary (per-invariant ✅/❌, gas used, latency, explorer links for testnet).
- **Exit nonzero on any invariant violation** → CI gate.

---

## 6. Scaffold layout
```
e2e/
  harness.ts          # orchestrator (modes/networks, assertions)
  invariants.ts       # money-invariant + conservation checkers (reusable)
  audit.ts            # F7 independent-audit algorithm (reusable verifier)
  faults.ts           # failure-injection hooks
  fixtures/           # golden prompts/hashes, seeded configs
  scenarios/          # happy.ts, negatives.ts, load.ts
contracts/tests/      # + invariant_tests, attestation_negative_tests, settlement_fuzz
node/test/            # + idempotency, walrus-down, serve-integration
sdk/test/             # + audit verifier units, create_job_from_ask integration
web/src/.../AuditDrawer.tsx + tests
```

## 7. Sequencing
1. Scaffold the harness + per-feature test suites (this pass).
2. Run L0–L5 on **localnet** (mock node) — green = logic correct.
3. Deploy staged pkg to testnet → run **L6 acceptance** with the real GB10 node.
4. When DEEP arrives: add the pool (`set_deepbook_pool_id`) and run the *same* harness with `create_job_from_fill` — the DeepBook path inherits all the rigor above.
