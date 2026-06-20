# Slide 06 — Verification & trust (the moat)

**On screen:** Left = four on-chain checks; right = "the guarantee" card + v1 scope / next.

**Duration:** ~80s

---

## Script

This slide is the moat — it's what makes GIX different from "decentralized compute" projects that are really just GPU rental.

When a provider submits its attestation, the **contract** — not an operator, not us — verifies four things on-chain:

1. **The vendor signature chain** validates up to a root that governance has pinned. A forged quote requires the hardware vendor's private key.
2. **The measurement is on the allowlist** — proving the *right* model and runtime ran, not some cheaper substitute.
3. **The hashes bind the job** — the model hash, your input hash, and the output hash all match this specific job. No swapping inputs, no replaying another job's output.
4. **It's within SLA and uses a fresh nonce** — on time, and not a replay.

Only if all four pass does settlement release the money.

So the guarantee we can make is precise: **"the approved model ran on your exact input and produced this exact output — provably."** And crucially, it's not "trust us" — **anyone** can independently reconstruct and re-verify a settled job from **Sui plus Walrus alone**, with no privileged access.

On scope: **v1 uses Intel TDX**, whose signatures Sui verifies natively, so the per-job check is cheap. On-chain **NVIDIA GPU Confidential Computing** verification is the fast-follow. And because the verifier is pluggable, a **zero-knowledge** backend could be added later without changing the rest of the protocol.

> **Transition:** "That's the trust core. Now let's look at what the platform actually does for users — the features."
