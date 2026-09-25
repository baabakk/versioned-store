---
title: v0.1 status
---

# v0.1 status

One canonical inventory of what is settled in `@versioned-store` today, what is known to be rough, and what comes next. This is the page to send someone who asks "what works, and what should I expect to change?"

**Last reconciled:** 2026-09-25, against the published packages and the repository, not against recollection.

**Where this is heading.** The API froze at `0.1.0-beta.6` on 2026-08-20. From that point no breaking change ships without a full deprecation cycle: a runtime shim, a deduplicated warning, then removal in a later release. The next release is additive.

---

## How to install while the version is a prerelease

**Pin the exact version. Do not use a caret range, and do not track the `beta` dist-tag.**

```jsonc
// package.json, recommended while the version is a prerelease
{
  "dependencies": {
    "@versioned-store/core": "0.1.0-beta.6",
    "@versioned-store/prompt-store": "0.1.0-beta.6"
  }
}
```

Two reasons, and the second is the one that catches people.

A caret on a prerelease does not mean what it looks like. `^0.1.0-beta.6` admits `0.1.0` final and every later `0.1.x`, so a routine install can move you across a release you never chose. The `beta` dist-tag has the same effect by a different route: it tracks the newest prerelease.

And the insulation that makes an upgrade cheap is a pattern, not a guarantee. Wiring the store at one construction site means an upgrade lands in one file rather than fifty, which is worth doing. It decides how much an upgrade costs; it does not decide when the upgrade happens. The pin decides that.

**This advice reverses at `1.0.0`.** Once a breaking change has to announce itself as a new major, a caret range is the right thing and pinning exactly stops being useful.

## What is settled in v0.1

These are load-bearing and covered by tests. Building on them is safe; the contract will not change without a deprecation cycle.

- **Immutable versions and a movable label.** A version, once written, is never rewritten. The `active` label is a pointer that moves. This is enforced at the storage layer, not by convention.
- **The code-default fallback.** An unseeded key, a missing label, a version that will not load, or an unreachable backend all resolve to the value compiled into your build. The store is never a hard dependency, which is what makes it safe in a boot path.
- **The eval-gate coupled to promote.** A gate runs before a version becomes active, and a refusal leaves the live version untouched.
- **The backend contract and its conformance suite.** Eight methods. Six backends ship (in-memory, file, SQLite, Postgres, Mongo, Redis) and every one is certified by `runConformance`, which is exported so a third-party backend can be held to the same standard.
- **The resolve caching model.** The label pointer is read fresh on every resolve; version content is cached forever per key and version, because a version is immutable. A promote therefore takes effect on the next resolve in every process, with no invalidation step.
- **The event schema.** Versioned via `STORE_EVENT_SCHEMA_VERSION`. New optional fields are added without a bump; a variant is never reshaped without one.
- **The error taxonomy.** Everything extends `VersionedStoreError`. Prefer the `isVersionedStoreError` guard over `instanceof`, because the guard still matches when two copies of the package are loaded.
- **Strict placeholder rendering in `prompt-store`**, with a golden-render promote gate, and command rendering with an executable allowlist in `scaffold-store`.
- **`checkDefaults(gate)`**, which runs every code default through its own gate so an unsound fallback is found at boot rather than on the day the database is down.
- **`createDrainableSink`**, so a short-lived process can flush an async audit sink before it closes its backend.
- **Field-level encryption at rest**, via an injected cipher and named fields, with the content hash and the gate operating over plaintext.

## What is rough, and known

Published here because a consumer finding this out by hitting it is worse than reading it.

- **The bundled command-line tool only drives SQLite and file backends.** It refuses Postgres, Mongo and Redis. If your store is on a networked backend, the operator surface is the separate `@versioned-store/cli` kit, which drives a store your application constructs, over any backend. This is the single roughest edge in the library today and it is being fixed.
- **There is no bulk read.** Reading many keys means listing keys and resolving each. An operator page over a few hundred keys will feel it.
- **Adding a version and promoting it are two calls.** There is no single atomic publish, so a crash between them leaves a version that was never made live.
- **There is no read API for promotion history.** The event sink tells you a promote happened; storing and querying that is currently yours to build.
- **`revertToCodeDefault` writes a copy.** It records the current shipped default as a new version and promotes it, so after a revert the key serves a frozen copy rather than following later changes to the default.
- **Domain hooks are store-wide.** `toDoc`, `fromDoc`, `validate`, `encryptedFields` and the promote gate do not receive the key, so a store holding several document shapes has to discriminate inside each hook.
- **Storage does not partition by domain.** Version and label rows are keyed by key alone. Two stores sharing one table pair share one key namespace; give each store its own table names when several share a database.
- **`prompt-store` has no `syncDefaults`.** Once a prompt key is seeded, an edited code default has no supported path to becoming live.
- **ESM only.** There is no CommonJS build today.
- **Third-party backend certification is outstanding.** The conformance suite is the documented contract, and no backend written by someone other than the author has yet been certified against it.

## What comes next

The next release is additive and leads with correctness rather than features:

1. An operator surface that works against every backend, which is the roughest edge above.
2. Making a mis-wired store say so at construction, instead of running quietly in a state its configuration implies it is not in.
3. A revert that returns a key to following the shipped default, rather than pinning a copy of it.
4. Bulk read and an atomic publish.
5. Promotion history owned by the library.

After those, the larger feature work: a gate that can check a version's output against stored cases rather than only its shape, and percentage rollout exposed through the domain packages.

## Reporting something

Open an issue on the repository. A report that names the version, the backend and what you expected is enough; a reproduction is a bonus rather than a requirement. Findings from real adoptions have driven most of the releases so far.
