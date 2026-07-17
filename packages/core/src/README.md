# versioned-store

An embedded-first, storage-portable, immutable-versioned config primitive with an eval-gate coupled to promote. One small core (`createVersionedStore<T>`) sits over an eight-method backend contract, with SQLite as the zero-config default plus InMemory, File, Postgres, Redis, and Mongo adapters.

Author: Babak.

## What it is

A production override layer for any payload `T`, not a version-control toy:

- **Immutable versions.** `addVersion` never overwrites; the new version is `max + 1`.
- **A movable label pointer.** `promote` flips `active` (also `staging`, `canary`, `shadow`); rollback flips it back.
- **A code-default fallback.** An in-code sentinel (version 0) is served when the label or version is missing, or when the backend is unreachable, under a per-domain null-vs-throw policy, so the store is never a hard dependency.
- **An eval-gate coupled to promote.** A failing candidate is refused at the pointer flip, so a bad edit sits inactive and never goes live.
- **Observability.** A versioned event schema (fallback, gate-outcome, promote-accepted, promote-refused) with a per-type counter.
- **Domain-agnostic.** The payload `T` maps via `toDoc` / `fromDoc`; `hash`, `validate`, and the missing-policy are injected. The core has no `if (domain === ...)` branch.

The defensible pairing is the runtime combination, not the immutable-versions or the movable-label (those are table stakes): the eval-gate coupled to promote so bad edits physically cannot go live, plus the code-default or offline fallback so the store is never a hard dependency, both over arbitrary `T`, embedded-first with SQLite by default. Lead with the pairing.

## Quickstart on SQLite (under five minutes)

```ts
import { createVersionedStore } from "@babak/versioned-store";
import { createSqliteBackend } from "@babak/versioned-store/backends/sqlite";

const store = createVersionedStore<{ text: string }>(
  {
    domain: "greeting",
    defaults: { hello: { text: "Hello!" } },
    hash: (v) => v.text,
    toDoc: (v) => ({ text: v.text }),
    fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
  },
  createSqliteBackend("./greetings.db"),
);

const v1 = await store.addVersion("hello", { text: "Hi there!" });
await store.promote("hello", v1);
const active = await store.resolve("hello"); // { version: 1, value: { text: "Hi there!" } }
```

The backend is always injected: the store never constructs one, so it carries no backend-specific dependency. InMemory / File / Redis import from the main entry; SQLite / Postgres / Mongo import from a subpath (they reference a driver type).

## Consuming the store: the rule of one construction site

Wire the store ONCE at a composition root and export a typed façade. Every other file in your app imports from that façade, never from `@babak/versioned-store` directly:

```ts
// src/config/prompts.ts — the one construction site
import { createVersionedStore, setStoreLogger } from "@babak/versioned-store";
import { createPostgresBackend } from "@babak/versioned-store/backends/postgres";
import { logger, pool } from "../infra.js";

setStoreLogger(logger); // inject your pino-compatible logger once
const prompts = createVersionedStore<Prompt>(promptCfg, createPostgresBackend(pool));

// the typed façade the rest of your app imports
export const resolvePrompt = (key: string) => prompts.resolve(key);
export const promotePrompt = prompts.promote;
```

This makes every future upgrade (additive or BREAKING) a one-file change on your side: fifty call sites become one file to touch. Do not leak the backend's internal shapes across the façade; expose only the intent-revealing verbs (`resolve` / `addVersion` / `promote` / `listVersions`).

## Backends

| Backend | Factory | Notes |
|---|---|---|
| InMemory | `createInMemoryBackend()` | reference implementation; tests and Mongo-less runs |
| SQLite | `createSqliteBackend(path)` | built-in `node:sqlite` (Node 22+); subpath import |
| File | `createFileBackend(dir)` | zero-dependency, durable; `wx`-flag immutability |
| Postgres | `createPostgresBackend(pool)` | inject a `pg` Pool; subpath import |
| Redis | `createRedisBackend(client, prefix)` | inject an ioredis-like client; atomic Lua insert |
| Mongo | `createMongoBackend(getDb, vColl, lColl)` | inject a `() => Promise<Db>`; subpath import |

Every backend passes the same conformance suite (`store.test.ts`): the immutability and compare-and-swap contract is identical across all of them.

## Eval-gate ladder (three tiers)

- **Tier 1 deterministic:** render, parse, and schema checks, fully offline. The domain supplies the predicate.
- **Tier 2 golden-output** (`goldenOutputGate`): render the candidate over golden inputs, then run promptfoo-style assertions on the output. Offline.
- **Tier 3 LLM-judge** (`llmJudgeGate`): score the output through an injected judge; skipped gracefully when no provider is configured. Pin the judge model version (calibration note in `evalGate.ts`).

`buildGate(config)` composes any subset of the three; `promote({ gate })` awaits it.

## Portability and rollout

- **Migration** (`migrate.ts`): a portable bundle moves between any two backends, verified by content hash.
- **Sealed bundles** (`bundle.ts`): a single-object, content-addressed, optionally HMAC-signed export; tampering is detected on import.
- **Canary and shadow** (`canary.ts`): weighted resolution plus gate-driven auto-rollback. A failing canary is demoted to the last-known-good and alarmed, embedded, with no hosted service.
- **CLI** (`npm run store -- <verb> ...`): keys, versions, get, label, promote, rollback, export, import, migrate.

## Certifying a new backend

Implement the `VersionedStoreBackend` contract (`backend.ts`, eight methods) and add your factory to the `BACKENDS` list in `store.test.ts`. If the conformance suite is green, the adapter is correct (immutability, CAS, ordering, labels).

## Honest positioning

Several properties here are not novel, and the positioning concedes each:

- **Immutable versions of an arbitrary payload:** AWS AppConfig already has this.
- **A movable pointer:** SSM labels, Dolt branches, and MLflow aliases already have this.
- **A deploy-time gate:** AppConfig validators, Langfuse eval-before-production, and LaunchDarkly approvals already have this; the schema-registry compatibility checks (Buf, Confluent) even run offline.

The claim is only the runtime bundle: the eval-gate coupled to promote so bad edits cannot go live, plus the code-default or offline fallback so the store is never a hard dependency, both over arbitrary `T`, embedded-first with SQLite by default. A reviewer should not be able to point to a single over-claim.

## Publishing (owner-driven, not automated)

This module currently lives inside the ADW application. Publishing it as a standalone package is a deliberate step for the maintainer, not something the build does:

1. Extract this directory into its own package or repository.
2. Choose a license and an npm scope or name.
3. Add the `exports` and `types` map plus a build.
4. Export the conformance suite as a public entry point so third parties can certify their own adapters.
5. Run `npm publish` with your credentials.
