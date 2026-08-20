# @versioned-store/core

## 0.1.0-beta.6

### Minor Changes

- a041e1c: `createPostgresBackend(pool, opts?)` now accepts optional table names.

  `createPostgresBackend(pool, { versionsTable, labelsTable })` lets several stores share one Postgres database without colliding, the same way the Mongo backend takes collection names and the Redis backend takes a prefix. Names are validated as strict SQL identifiers and double-quoted, so a name cannot inject SQL. The default is unchanged (`versions` / `labels`, quoted lowercase, identical to the historical unquoted tables), so existing deployments are unaffected.

  This also unblocks the live-backend conformance run (beta.0 gate #4): each factory call can namespace to its own scratch tables on a real Postgres server, which the mock (single-event-loop) conformance cannot exercise for the multi-connection CAS race.

- 8dcfc1d: verify-on-seed: `seedDefaults` and `syncDefaults` can now refuse an unsound code default instead of promoting it to active.

  Seed and sync promote the code default to the ACTIVE version, so a default that could not pass its own gate would be made active unvalidated. That is the "seed hole" `checkDefaults` was added to detect; this closes it on the write side.

  - **core:** `seedDefaults(opts?)` and `syncDefaults(opts?)` accept an optional `{ gate: DefaultsGate<T> }`. When a gate is supplied, each default is verified before it is promoted; a default the gate rejects is skipped and reported (`seedDefaults` returns `{ key, seeded: false, refused: true, failures }`; `syncDefaults` returns `{ key, action: "refused", failures }`). Seed/sync never throw on an unsound default, so one bad default cannot halt the run. New exported types `SeedResult`, `SyncResult`. Without a gate, behavior is unchanged (every default is seeded).
  - **prompt-store / scaffold-store:** their `seedDefaults` (and scaffold-store's `syncDefaults`) now ALWAYS auto-inject the same gate `promote` uses, so a facade consumer's boot seed cannot make an unsound default active. This is a behavior change for a consumer that ships an unsound default: it is now refused rather than promoted. Inspect the returned report; the policy on a refused default (fail boot, warn) stays the consumer's.
  - **cli:** a descriptor may carry an optional `gate`; when present, the `seed` and `sync` verbs verify each default and report refusals, and the verb exits non-zero if any default was refused, so an operator or CI step fails loudly.

  The refused default is still SERVED via the fallback path (the sentinel v0), which the consumer guards at boot with `checkDefaults`. Additive API; the behavior change only affects a store that ships a default its own gate rejects.

## 0.1.0-alpha.5

### Minor Changes

- bb49f9f: Add `checkDefaults(gate)` — verify the code defaults are gate-valid (the fallback-soundness check).

  A code default is served on every `resolve` fallback AND is the value `revertToCodeDefault` re-promotes, so it must be able to pass the same eval-gate a candidate version must. Nothing enforced that before, and every consumer hand-rolled the loop.

  - **Core:** a new `VersionedStore.checkDefaults(gate)` runs a supplied per-key gate over every registered default and returns `{ ok, results: [{ key, passed, failures }] }`. Pure: reads only the in-code defaults, touches no backend, emits no event, never throws. New exported types `DefaultsGate<T>`, `DefaultCheck`, `DefaultsHealthReport`. The gate is `(key, value)` because a domain's gate is per-key.
  - **prompt-store / scaffold-store:** a zero-argument `checkDefaults()` that reuses each facade's OWN promote-gate (the placeholder + golden-render gate for prompts; the pinning + binding + allowlist gate for scaffolds), so the check and the promote can never drift.
  - The POLICY on an unhealthy default (throw at boot, warn, degrade) stays the consumer's; the library only reports.

  Additive; no breaking changes.

- a83a4ba: Add `createDrainableSink(inner)` — make an async `onEvent` sink flushable before process exit.

  `onEvent` is synchronous by contract, so a sink that persists to a networked store must detach its write. That is correct for a long-lived host and wrong for a short-lived one: a CLI closes its backend connection the instant the verb returns, and the detached write loses its session, so the audit row is never written (the `TD-VS-15` failure a downstream consumer hit: an events collection with zero rows).

  `createDrainableSink(inner, { onError? })` returns `{ onEvent, drain }`. `inner` does the persistence and returns its promise; the wrapper detaches it (so the store never blocks) but tracks it, and `drain()` awaits every write scheduled so far. A sync throw or async rejection is caught and routed to `onError` (default: a warning), never rethrown, preserving the swallow-and-warn posture (an audit row must never break a kill switch). Wire `onEvent` at store construction and `await drain()` after the verb, before closing the backend.

  Additive; zero new dependencies. Foundational for the `@versioned-store/cli` runner's connect → verb → drain → close lifecycle.

- 94a0bd8: Add opt-in field-level encryption at rest.

  A sensitive config value (an API secret embedded in a config blob) was stored plaintext in the backend. This adds an optional at-rest cipher without becoming a secrets manager (key storage, leasing, and rotation stay the host's).

  - **core:** a `StoreCipher` interface (`encrypt`/`decrypt` over opaque strings, sync or async) plus `cipher?` and `encryptedFields?` on `VersionedStoreConfig`. The store encrypts named fields AFTER `toDoc` on write and decrypts them BEFORE `fromDoc` on read; `encryptedFields` defaults to every field `toDoc` emits, or names a subset to keep the rest queryable at rest. The content hash and the eval-gate stay over the PLAINTEXT value, so dedup, `syncDefaults` change-detection, and gating are all unchanged, and a randomized cipher carries no dedup penalty. Every unreadable case (wrong key, tampered ciphertext, a pre-cipher cleartext version) fails CLOSED to the code default.
  - **core (`@versioned-store/core/cipher` subpath):** a ready-made `createAesGcmCipher({ key, aad? })` (AES-256-GCM over node:crypto, zero dependencies). Fresh random IV per record; output is `vsc1:<base64url(iv|tag|ciphertext)>`; `decrypt` verifies the GCM tag and throws on any tamper. The main entry stays free of an opinionated cipher.
  - **prompt-store / scaffold-store:** `cipher?` and `encryptedFields?` threaded through both facades.

  Additive; no breaking changes. Versions are immutable, so enabling the cipher protects future versions only: a version written before it stays cleartext and now fails to decrypt (fail-closed), so a clean migration enables the cipher, re-publishes, and then rotates the secret. Threat model: protects the backend at rest, NOT a live compromised process (which holds the key and the decrypted resolve cache).

## 0.1.0-alpha.4

### Patch Changes

- Fix: add the missing `note` field to the `VersionedStore.promote` interface.

  `promote`'s implementation has accepted an optional `note` since 0.1.0-alpha.3 (it persists on the label and rides the `promote-accepted` event), but the public `VersionedStore` interface omitted it. A TypeScript caller passing `{ note }` therefore failed to type-check against the published `.d.ts` even though the call worked at runtime. The interface now matches the implementation. Runtime behavior is unchanged; this is a types-only correction.

  The gap escaped both gates: the test runner strips types (`tsx`), and the build excludes test files, so no compile ever exercised the interface against a `note`-passing caller. The facades' own `core.promote(..., { note })` calls are what surfaced it.

## 0.1.0-alpha.3

### Minor Changes

- 4b9402d: Promote-path additions, plus two fixes.

  - **`onEvent` sink:** an optional `VersionedStoreConfig.onEvent` hook fires on every store event (`fallback`, `gate-outcome`, `promote-refused`, `promote-accepted`) alongside the injected logger, swallowing sink errors. It captures promotions that bypass wrapper code (scripts, admin routes, the ungated kill-switch), which is what makes a durable promotion-history / audit trail possible.
  - **`note` on `promote` and persisted `refs`:** `promote` gains an optional `note`; both `note` and `refs` now persist on the label (previously `refs` was emitted on the event but never stored), and `note` also rides the `promote-accepted` event.
  - **`revertToCodeDefault(key)`:** a first-class, ungated single-key kill-switch that adds the in-code default as a new version and promotes it, returning the new version. Prefer it over `syncDefaults()` (which reverts every key) and over `promote(key, 0)` (which now throws a clear `KillSwitchNotSupportedError` pointing at it).
  - **Fix (CLI):** the `versioned-store` bin now ships a `#!/usr/bin/env node` shebang, so it runs on Unix (it was broken there in 0.1.0-alpha.0 through alpha.2, masked on Windows).
  - **Fix (conformance):** the concurrent-`addVersion` test now creates its indexes, so a backend's compare-and-swap is genuinely certified on Mongo.

  All additive or fixes; no breaking changes.

## 0.1.0-alpha.2

### Minor Changes

- Add `isVersionedStoreError(e)` type guard for robust error detection across duplicate package copies.

  `VersionedStoreError` is now branded with a global-registry symbol (`Symbol.for`), and the new `isVersionedStoreError` guard checks that brand instead of prototype identity. A blanket `catch (e) { if (isVersionedStoreError(e)) ... }` now covers errors thrown even by a second loaded copy of the package (a transitive version split, or a bundler that duplicates it), where `e instanceof VersionedStoreError` silently returns false. Existing `instanceof` checks keep working for the common single-copy case; the guard is the additional, copy-robust path. Same hazard class and remedy as the zod-`instanceof` fix in `@versioned-store/prompt-store@0.1.0-alpha.1`.

## 0.1.0-alpha.0

### Minor Changes

- 0b584c7: First alpha of the versioned-store workspace.

  `@versioned-store/core` is the generic primitive: immutable versions of an arbitrary payload `T`, a movable label pointer, a code-default fallback, and an eval-gate coupled to promote, over an eight-method backend contract. Six backends ship (InMemory, SQLite, File, Postgres, Redis, Mongo), all certified by the same exported conformance suite, plus migration, sealed portable bundles, canary/shadow with gate-driven auto-rollback, a versioned event schema, an error taxonomy, and a CLI.

  `@versioned-store/prompt-store` and `@versioned-store/scaffold-store` are batteries-included domain stores on that core: strict placeholder rendering with a golden-render promote-gate for prompts, and pinning plus placeholder-binding plus an executable allowlist for scaffolds.

  The main entry of every package is dependency-free and Node 18 safe; anything that needs a driver (`node:sqlite`, `pg`, `mongodb`) is a subpath export.
