---
"@versioned-store/cli": minor
---

New package: `@versioned-store/cli`, a descriptor-driven operator surface.

You hand it one `StoreDescriptor` per store domain (built from a facade's public `.core`, gated `promote`, and zero-arg `checkDefaults` via `makeDescriptor`), and `createStoreCli` drives a uniform verb set: `list / add / promote / revert / diff / seed / sync / health`. `run(argv)` returns an exit code and never throws.

Three properties are load-bearing, and each removes a failure a hand-rolled admin surface exhibited in a live rollback rehearsal:

- **Gated promote by construction.** The descriptor's store surface `Omit`s the ungated `promote`, so the only promote the CLI can reach is the domain's gated one. A version the eval-gate would refuse cannot be promoted, and the raw `.core.promote(` that had to be policed by a CI grep is off the type.
- **`health` covers every registered domain** and exits non-zero if any has an unhealthy code default, so an operator surface cannot silently omit a payload family (`TD-VS-CONFIG-STORE-HAS-NO-OPERATOR-SURFACE`).
- **The runner owns the audit-sink drain.** Its lifecycle is connect then verb then drain then close, so a promote's audit row lands before a short-lived CLI process closes the backend (`TD-VS-15`, paired with `createDrainableSink`).

Depends only on `@versioned-store/core`. No backend driver, no bin: the host wires a thin bin with its own `connect`/`close`.
