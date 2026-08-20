# @versioned-store/prompt-store

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

- bb49f9f: Add `checkDefaults(gate)` — verify the code defaults are gate-valid (the fallback-soundness check).

  A code default is served on every `resolve` fallback AND is the value `revertToCodeDefault` re-promotes, so it must be able to pass the same eval-gate a candidate version must. Nothing enforced that before, and every consumer hand-rolled the loop.

  - **Core:** a new `VersionedStore.checkDefaults(gate)` runs a supplied per-key gate over every registered default and returns `{ ok, results: [{ key, passed, failures }] }`. Pure: reads only the in-code defaults, touches no backend, emits no event, never throws. New exported types `DefaultsGate<T>`, `DefaultCheck`, `DefaultsHealthReport`. The gate is `(key, value)` because a domain's gate is per-key.
  - **prompt-store / scaffold-store:** a zero-argument `checkDefaults()` that reuses each facade's OWN promote-gate (the placeholder + golden-render gate for prompts; the pinning + binding + allowlist gate for scaffolds), so the check and the promote can never drift.
  - The POLICY on an unhealthy default (throw at boot, warn, degrade) stays the consumer's; the library only reports.

  Additive; no breaking changes.

- 94a0bd8: Add opt-in field-level encryption at rest.

  A sensitive config value (an API secret embedded in a config blob) was stored plaintext in the backend. This adds an optional at-rest cipher without becoming a secrets manager (key storage, leasing, and rotation stay the host's).

  - **core:** a `StoreCipher` interface (`encrypt`/`decrypt` over opaque strings, sync or async) plus `cipher?` and `encryptedFields?` on `VersionedStoreConfig`. The store encrypts named fields AFTER `toDoc` on write and decrypts them BEFORE `fromDoc` on read; `encryptedFields` defaults to every field `toDoc` emits, or names a subset to keep the rest queryable at rest. The content hash and the eval-gate stay over the PLAINTEXT value, so dedup, `syncDefaults` change-detection, and gating are all unchanged, and a randomized cipher carries no dedup penalty. Every unreadable case (wrong key, tampered ciphertext, a pre-cipher cleartext version) fails CLOSED to the code default.
  - **core (`@versioned-store/core/cipher` subpath):** a ready-made `createAesGcmCipher({ key, aad? })` (AES-256-GCM over node:crypto, zero dependencies). Fresh random IV per record; output is `vsc1:<base64url(iv|tag|ciphertext)>`; `decrypt` verifies the GCM tag and throws on any tamper. The main entry stays free of an opinionated cipher.
  - **prompt-store / scaffold-store:** `cipher?` and `encryptedFields?` threaded through both facades.

  Additive; no breaking changes. Versions are immutable, so enabling the cipher protects future versions only: a version written before it stays cleartext and now fails to decrypt (fail-closed), so a clean migration enables the cipher, re-publishes, and then rotates the secret. Threat model: protects the backend at rest, NOT a live compromised process (which holds the key and the decrypted resolve cache).

### Patch Changes

- Updated dependencies [bb49f9f]
- Updated dependencies [a83a4ba]
- Updated dependencies [94a0bd8]
  - @versioned-store/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Minor Changes

- Thread the full promote surface through both facades.

  `createPromptStore` and `createScaffoldStore` build the core store by PICKING config fields, so the promote-path additions from `@versioned-store/core@0.1.0-alpha.3` were reachable only by calling `createVersionedStore` directly, never through the facade. Since the facade is the high-traffic surface (all the promote traffic goes through it), promotion audit and history were effectively impossible for a facade consumer. Both facades now pass the surface through:

  - **`onEvent`:** a new `onEvent?(event)` option on `PromptStoreOptions` / `ScaffoldStoreOptions`, forwarded to the core. A host can now persist an at-source audit trail of promotions through the facade, which is what makes promotion history queryable.
  - **`note` + `refs` on `promote`:** both facade `promote` methods now accept `note` and `refs` and forward them, so they persist on the label and ride the `promote-accepted` event.
  - **`revertToCodeDefault(key)`:** the ungated single-key kill-switch is now exposed on both facades.

  Additive; no breaking changes.

### Patch Changes

- Updated dependencies
  - @versioned-store/core@0.1.0-alpha.4

## 0.1.0-alpha.1

### Patch Changes

- Detect var-schema fields structurally (by the schema's `.shape`) instead of `instanceof z.ZodObject`.

  `instanceof` is only true when the package's zod and the consumer's zod are the same module instance, so a duplicated or version-split zod in the consumer's dependency tree silently disabled the promote-gate's unknown-placeholder check (it returned "no known fields", so every placeholder looked valid). Render-time validation was never affected, since it calls `.safeParse` on the consumer's own schema instance; this closes the gap in the gate's field enumeration. The structural check also works across zod 3 and 4. Documented the bring-your-own-zod behavior in the README.

## 0.1.0-alpha.0

### Minor Changes

- 0b584c7: First alpha of the versioned-store workspace.

  `@versioned-store/core` is the generic primitive: immutable versions of an arbitrary payload `T`, a movable label pointer, a code-default fallback, and an eval-gate coupled to promote, over an eight-method backend contract. Six backends ship (InMemory, SQLite, File, Postgres, Redis, Mongo), all certified by the same exported conformance suite, plus migration, sealed portable bundles, canary/shadow with gate-driven auto-rollback, a versioned event schema, an error taxonomy, and a CLI.

  `@versioned-store/prompt-store` and `@versioned-store/scaffold-store` are batteries-included domain stores on that core: strict placeholder rendering with a golden-render promote-gate for prompts, and pinning plus placeholder-binding plus an executable allowlist for scaffolds.

  The main entry of every package is dependency-free and Node 18 safe; anything that needs a driver (`node:sqlite`, `pg`, `mongodb`) is a subpath export.

### Patch Changes

- Updated dependencies [0b584c7]
  - @versioned-store/core@0.1.0-alpha.0
