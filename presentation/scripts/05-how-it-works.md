# Slide 05 — How it works (job lifecycle)

**On screen:** Horizontal pipeline (Order+match → Escrow → Dispatch → Run·TEE → Attest → Verify) branching into Settle (pass) and Refund+Slash (fail).

**Duration:** ~75s

---

## Script

Let's follow one job end to end.

**Order + match.** A consumer buys compute on the DeepBook order book; a provider's resting ask is filled. That fill is the trigger.

**Escrow.** The consumer's USDC is locked into an on-chain **escrow** bound to a new `Job` object. The money is now committed, but nobody's been paid.

**Dispatch.** The job is dispatched to the matched provider.

**Run, inside the TEE.** The provider's node loads the exact model and input from Walrus and runs the inference **inside the Trusted Execution Environment**.

**Attest.** The hardware emits a signed quote binding the runtime measurement and the model, input, and output hashes — plus timing for the SLA.

**Verify — the on-chain gate.** The `attestation` module checks that proof on-chain. And here's the fork:

- **Pass → Settle.** The provider is paid from escrow, minus the protocol fee; the compute credits are burned; the output and audit evidence stay on Walrus.
- **Fail → Refund + Slash.** If the proof is missing, late, or invalid, the consumer is fully refunded and the provider's **staked bond is slashed.** Misbehaving costs money.

Two things make this scale: escrow **only ever releases against a verified proof**, so consumers are protected by construction; and **every `Job` is an independent Sui object**, so thousands of jobs settle in parallel with sub-second finality — there's no global bottleneck.

> **Transition:** "That verification step is the heart of the system — let's zoom in on exactly what gets checked."
