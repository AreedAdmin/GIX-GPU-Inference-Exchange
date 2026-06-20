/// Concrete per-market witness types (the `M` in `Market<M>` / `Credit<M>`).
///
/// Each market needs a distinct, package-defined phantom brand so its `Credit<M>` is a
/// unique fungible coin. Adding a new market = adding a witness here (and a `create_market`
/// call). The integration contract's `deployment.json` references the M1 market by its
/// fully-qualified type, e.g. `<pkg>::markets::M_H100_LLAMA8B`.
///
/// These are zero-sized brands; they carry no value and are never instantiated as values —
/// only used as type parameters.
module gix::markets;

/// M1 baseline market: H100 GPU class, llama-3.1-8b-int8 model tier.
public struct M_H100_LLAMA8B has drop {}

/// A second example market brand (A100 tier) to show multi-market typing; the deploy
/// script may or may not instantiate it in M1.
public struct M_A100_LLAMA8B has drop {}
