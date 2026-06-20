/**
 * Fault selection: turn the scenario's fault-injection rates into a per-job
 * `FaultClass`, deterministically (driven by the seeded Rng).
 *
 * The three rates are treated as mutually-exclusive probability mass over a
 * single uniform draw, resolved in priority order skip → late → wrong. Their sum
 * is validated ≤ 1 at config load; the remaining mass is the happy path.
 */

import type { FaultRates } from "../config/types.js";
import { FaultClass } from "../orchestrator/model.js";
import type { Rng } from "../util/rng.js";

export function selectFault(rates: FaultRates, rng: Rng): FaultClass {
  const r = rng.next();
  let acc = rates.skipAttest;
  if (r < acc) return FaultClass.SkipAttest;
  acc += rates.lateAttest;
  if (r < acc) return FaultClass.LateAttest;
  acc += rates.wrongOutput;
  if (r < acc) return FaultClass.WrongOutput;
  return FaultClass.None;
}
