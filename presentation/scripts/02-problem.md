# Slide 02 — Problem statement

**On screen:** "Compute is priced like real estate" + two columns of pain points; closing line about overpaying and not being able to prove what you got.

**Duration:** ~75s

---

## Script

Here's the problem. Today, **buying GPU compute feels like leasing real estate** — it's illiquid, opaque, and unverifiable.

**First, capacity is locked.** You rent a whole GPU by the hour and pay for it whether you use it or not. AI workloads are bursty, so you're constantly paying for idle time, or over-provisioning to avoid running out.

**Second, pricing is opaque.** You get a *list price* from each vendor — not a real, continuous market. There's no neutral spot price that tells you what an inference actually costs right now.

**Third, and most importantly — it's a black box.** When you call a hosted inference API, you have no way to prove which model actually ran. Providers can silently swap a model, quantize it down, or truncate outputs to cut costs, and you'd never know. For agents, for regulated workloads, for anything where correctness matters, that's a real risk.

**Fourth, you're trusting a single company** for settlement, refunds, and SLAs. If they go down or behave badly, you have no recourse except their support queue.

And on the supply side, there's a mirror problem: **huge amounts of GPU capacity sit idle** — in data centers, in spare fleets — with no neutral, permissionless venue to sell it per-job.

The net result: **AI builders overpay for committed capacity, and still can't prove they got what they paid for.** That's the gap GIX closes.

> **Transition:** "So what does the fix look like?"
