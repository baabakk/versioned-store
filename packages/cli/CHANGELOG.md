# @versioned-store/cli

## 0.1.0-beta.6

### Minor Changes

- 8dcfc1d: verify-on-seed: `seedDefaults` and `syncDefaults` can now refuse an unsound code default instead of promoting it to active.

  Seed and sync promote the code default to the ACTIVE version, so a default that could not pass its own gate would be made active unvalidated. That is the "seed hole" `checkDefaults` was added to detect; this closes it on the write side.

  - **core:** `seedDefaults(opts?)` and `syncDefaults(opts?)` accept an optional `{ gate: DefaultsGate<T> }`. When a gate is supplied, each default is verified before it is promoted; a default the gate rejects is skipped and reported (`seedDefaults` returns `{ key, seeded: false, refused: true, failures }`; `syncDefaults` returns `{ key, action: "refused", failures }`). Seed/sync never throw on an unsound default, so one bad default cannot halt the run. New exported types `SeedResult`, `SyncResult`. Without a gate, behavior is unchanged (every default is seeded).
  - **prompt-store / scaffold-store:** their `seedDefaults` (and scaffold-store's `syncDefaults`) now ALWAYS auto-inject the same gate `promote` uses, so a facade consumer's boot seed cannot make an unsound default active. This is a behavior change for a consumer that ships an unsound default: it is now refused rather than promoted. Inspect the returned report; the policy on a refused default (fail boot, warn) stays the consumer's.
  - **cli:** a descriptor may carry an optional `gate`; when present, the `seed` and `sync` verbs verify each default and report refusals, and the verb exits non-zero if any default was refused, so an operator or CI step fails loudly.

  The refused default is still SERVED via the fallback path (the sentinel v0), which the consumer guards at boot with `checkDefaults`. Additive API; the behavior change only affects a store that ships a default its own gate rejects.

### Patch Changes

- Updated dependencies [a041e1c]
- Updated dependencies [8dcfc1d]
  - @versioned-store/core@0.1.0-beta.6

## 0.1.0-alpha.5

### Minor Changes

- 28dbbdf: New package: `@versioned-store/cli`, a descriptor-driven operator surface.

  You hand it one `StoreDescriptor` per store domain (built from a facade's public `.core`, gated `promote`, and zero-arg `checkDefaults` via `makeDescriptor`), and `createStoreCli` drives a uniform verb set: `list / add / promote / revert / diff / seed / sync / health`. `run(argv)` returns an exit code and never throws.

  Three properties are load-bearing, and each removes a failure a hand-rolled admin surface exhibited in a live rollback rehearsal:

  - **Gated promote by construction.** The descriptor's store surface `Omit`s the ungated `promote`, so the only promote the CLI can reach is the domain's gated one. A version the eval-gate would refuse cannot be promoted, and the raw `.core.promote(` that had to be policed by a CI grep is off the type.
  - **`health` covers every registered domain** and exits non-zero if any has an unhealthy code default, so an operator surface cannot silently omit a payload family (`TD-VS-CONFIG-STORE-HAS-NO-OPERATOR-SURFACE`).
  - **The runner owns the audit-sink drain.** Its lifecycle is connect then verb then drain then close, so a promote's audit row lands before a short-lived CLI process closes the backend (`TD-VS-15`, paired with `createDrainableSink`).

  Depends only on `@versioned-store/core`. No backend driver, no bin: the host wires a thin bin with its own `connect`/`close`.

### Patch Changes

- Updated dependencies [bb49f9f]
- Updated dependencies [a83a4ba]
- Updated dependencies [94a0bd8]
  - @versioned-store/core@0.1.0-alpha.5
