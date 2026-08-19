---
title: Backends
---

# Backends

The core never constructs a backend. The host composes one and injects it, which is why the core carries no driver dependency and why swapping storage is a one-line change at your construction site.

## Choosing one

| Backend | Factory | Import | Use it when |
|---|---|---|---|
| InMemory | `createInMemoryBackend()` | main entry | tests, and backend-less local runs |
| SQLite | `createSqliteBackend(path)` | `/backends/sqlite` | embedded default; zero config, durable, Node 22+ |
| File | `createFileBackend(dir)` | main entry | zero dependency and durable, with OS-level write-exclusive immutability |
| Postgres | `createPostgresBackend(pool, opts?)` | `/backends/postgres` | you already run Postgres and want config beside your data |
| Mongo | `createMongoBackend(getDb, versions, labels)` | `/backends/mongo` | you already run Mongo |
| Redis | `createRedisBackend(client, prefix)` | main entry | you already run Redis; insert is an atomic Lua script |

Anything needing a driver is a SUBPATH export, so importing `@versioned-store/core` never loads `node:sqlite`, `pg`, or `mongodb`. That is what keeps the main entry dependency-free and Node 18 safe.

## Sharing one database between stores

Several stores can share one database without colliding, because each networked backend takes its own namespace:

```ts
createPostgresBackend(pool, { versionsTable: "prompt_versions", labelsTable: "prompt_labels" });
createMongoBackend(() => getDb(), "config_versions", "config_labels");
createRedisBackend(client, "prompts");
```

Postgres table names are validated as strict identifiers and quoted, so a name cannot inject SQL. The defaults (`versions` / `labels`) are the historical names, so an existing deployment is unaffected by the parameter existing.

## The contract, and certifying your own

A backend implements about eight methods and owns storage only: no policy, no domain knowledge, no branching on the payload. The load-bearing guarantee is that `insertVersion` must throw `BackendConflictError` when `(key, version)` already exists. That conflict is the compare-and-swap signal the core's retry loop depends on to keep concurrent writers from losing an update, and it is why versions can be trusted to be immutable.

Any backend, including a third-party one, proves itself against the same suite this repo runs against its own:

```ts
import { runConformance } from "@versioned-store/core/conformance";

runConformance("MyBackend", () => makeMyBackend());   // factory must return a FRESH, isolated backend
```

Green means the adapter honors immutability, compare-and-swap, version ordering, and labels. If it is not green, it is not a backend.

## Mocks prove less than servers

The suite runs against in-process fakes in normal test runs, and that is genuinely useful, but a single JavaScript event loop cannot exhibit the multi-connection race the compare-and-swap guarantee exists for: with one loop, no two writers are ever truly in flight at the same instant.

For that reason the same suite also runs in CI against real Postgres, Mongo, and Redis servers, where contention lands on distinct pool connections and the unique-constraint conflict is genuine. If you are certifying your own adapter for production use, run it against a real server too, not only against a mock.
