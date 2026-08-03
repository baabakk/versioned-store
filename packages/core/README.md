# @versioned-store/core

An embedded-first, storage-portable, immutable-versioned config primitive with an **eval-gate coupled to promote**. One small core (`createVersionedStore<T>`) sits over an eight-method backend contract, with SQLite as the zero-config default plus InMemory, File, Postgres, Redis, and Mongo adapters.

```bash
npm install @versioned-store/core
```

## What it is

A production override layer for any payload `T`, not a version-control toy:

- **Immutable versions.** `addVersion` never overwrites; the new version is `max + 1`.
- **A movable label pointer.** `promote` flips `active` (also `staging`, `canary`, `shadow`); rollback flips it back.
- **A code-default fallback.** An in-code sentinel (version 0) is served when the label or version is missing, or when the backend is unreachable, under a per-domain null-vs-throw policy, so the store is never a hard dependency.
- **An eval-gate coupled to promote.** A failing candidate is refused at the pointer flip, so a bad edit sits inactive and never goes live.
- **Observability.** A versioned event schema (fallback, gate-outcome, promote-accepted, promote-refused) with a per-type counter.
- **Domain-agnostic.** The payload `T` maps via `toDoc` / `fromDoc`; `hash`, `validate`, and the missing-policy are injected. The core has no `if (domain === ...)` branch.

The defensible thing is the runtime **pairing**, not any single piece. See [Honest positioning](#honest-positioning).

## Quickstart on SQLite (under five minutes)

```ts
import { createVersionedStore } from "@versioned-store/core";
import { createSqliteBackend } from "@versioned-store/core/backends/sqlite";

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

The backend is always injected: the store never constructs one, so it carries no backend-specific dependency.

## Entry points

The main entry is dependency-free and works on Node 18. Anything that needs a driver is a subpath, so importing the core never loads `node:sqlite`, `pg`, or `mongodb`:

| Import | Requires |
|---|---|
| `@versioned-store/core` | nothing (Node 18+) |
| `@versioned-store/core/backends/sqlite` | `node:sqlite` (Node 22+) |
| `@versioned-store/core/backends/postgres` | `pg` |
| `@versioned-store/core/backends/mongo` | `mongodb` |
| `@versioned-store/core/conformance` | nothing |
| `@versioned-store/core/cli` | `node:sqlite` (Node 22+) |

InMemory, File, and Redis (an injected client) are driver-free and export from the main entry.

## Consuming the store: the rule of one construction site

Wire the store ONCE at a composition root and export a typed façade. Every other file in your app imports from that façade, never from `@versioned-store/core` directly:

```ts
// src/config/prompts.ts — the one construction site
import { createVersionedStore, setStoreLogger } from "@versioned-store/core";
import { createPostgresBackend } from "@versioned-store/core/backends/postgres";
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
| InMemory | `createInMemoryBackend()` | reference implementation; tests and backend-less runs |
| SQLite | `createSqliteBackend(path)` | built-in `node:sqlite` (Node 22+); subpath import |
| File | `createFileBackend(dir)` | zero-dependency, durable; `wx`-flag immutability |
| Postgres | `createPostgresBackend(pool)` | inject a `pg` Pool; subpath import |
| Redis | `createRedisBackend(client, prefix)` | inject an ioredis-like client; atomic Lua insert |
| Mongo | `createMongoBackend(getDb, vColl, lColl)` | inject a `() => Promise<Db>`; subpath import |

Every backend passes the same conformance suite: the immutability and compare-and-swap contract is identical across all of them.

## Eval-gate ladder (three tiers)

- **Tier 1 deterministic:** render, parse, and schema checks, fully offline. The domain supplies the predicate.
- **Tier 2 golden-output** (`goldenOutputGate`): render the candidate over golden inputs, then run promptfoo-style assertions on the output. Offline.
- **Tier 3 LLM-judge** (`llmJudgeGate`): score the output through an injected judge; skipped gracefully when no provider is configured. Pin the judge model version (calibration note in `evalGate.ts`).

`buildGate(config)` composes any subset of the three; `promote({ gate })` awaits it.

## Portability and rollout

- **Migration** (`migrate`): a portable bundle moves between any two backends, verified by content hash.
- **Sealed bundles** (`bundle`): a single-object, content-addressed, optionally HMAC-signed export; tampering is detected on import.
- **Canary and shadow** (`canary`): weighted resolution plus gate-driven auto-rollback. A failing canary is demoted to the last-known-good and alarmed, embedded, with no hosted service.
- **CLI** (`npx versioned-store <verb> ...`): keys, versions, get, label, promote, rollback, export, import, migrate.

## Error handling

Every error the store throws extends `VersionedStoreError` (subclasses: `VersionNotFoundError`, `GateRejectedError`, `CasExhaustedError`, `BackendConflictError`), so one blanket `catch` covers the whole library. Prefer the `isVersionedStoreError(e)` guard over `e instanceof VersionedStoreError`:

```ts
import { isVersionedStoreError } from "@versioned-store/core";

try {
  await store.promote("greeting", 7, { gate });
} catch (e) {
  if (isVersionedStoreError(e)) {
    // any store failure: a rejected gate, a missing version, CAS exhaustion...
  } else {
    throw e;
  }
}
```

`isVersionedStoreError` matches even an error thrown by a second loaded copy of the package (a transitive version split, or a bundler that duplicates it), where `instanceof` silently returns false. A subclass check still lets a specific handler add one line.

## Certifying a new backend

Implement the `VersionedStoreBackend` contract (`backend.ts`, eight methods), then run the same suite this repo runs against its own adapters:

```ts
import { runConformance } from "@versioned-store/core/conformance";

runConformance("MyBackend", () => makeMyBackend());
```

If it is green, the adapter honours immutability, compare-and-swap, version ordering, and labels.

## Honest positioning

Several properties here are not novel, and the positioning concedes each:

- **Immutable versions of an arbitrary payload:** AWS AppConfig already has this.
- **A movable pointer:** SSM labels, Dolt branches, and MLflow aliases already have this.
- **A deploy-time gate:** AppConfig validators, Langfuse eval-before-production, and LaunchDarkly approvals already have this; the schema-registry compatibility checks (Buf, Confluent) even run offline.

The claim is only the runtime bundle: the eval-gate coupled to promote so bad edits cannot go live, plus the code-default or offline fallback so the store is never a hard dependency, both over arbitrary `T`, embedded-first with SQLite by default. A reviewer should not be able to point to a single over-claim.

## Domain packages

[`@versioned-store/prompt-store`](../prompt-store) and [`@versioned-store/scaffold-store`](../scaffold-store) are batteries-included domain stores built on this core. They are worked examples of the pattern: payload shape, rendering, and a domain gate on top; policy and storage below.

MIT.
