// Public API barrel for @versioned-store/core. The main entry exports the core, the storage-agnostic
// tooling, and the driver-free backends (InMemory, File, and Redis via an injected client). SQLite
// (node:sqlite, Node 22+), Postgres, and Mongo are SUBPATH exports, so importing the main barrel never
// loads node:sqlite / pg / mongodb and the core entry stays Node-18-safe:
//   import { createSqliteBackend }   from "@versioned-store/core/backends/sqlite"    // node:sqlite (Node 22+)
//   import { createPostgresBackend } from "@versioned-store/core/backends/postgres"  // needs `pg`
//   import { createMongoBackend }    from "@versioned-store/core/backends/mongo"     // needs `mongodb`
//
// The CLI is subpath-only for the same reason: it constructs a sqlite backend from a spec string, so
// exporting it here would drag node:sqlite into every consumer's import graph (it did, until it did not):
//   import { run, backendFromSpec } from "@versioned-store/core/cli"                 // node:sqlite (Node 22+)

export * from "./versionedStore.js";
export * from "./backend.js";
export * from "./errors.js";
export * from "./logger.js";
export * from "./events.js";
export * from "./migrate.js";
export * from "./bundle.js";
export * from "./evalGate.js";
export * from "./canary.js";
export * from "./conformance.js";

// Driver-free backends, safe in the main entry. SQLite / Postgres / Mongo are subpath-only (see the header).
export { createInMemoryBackend } from "./backends/memory.js";
export { createFileBackend } from "./backends/file.js";
export { createRedisBackend, type RedisLike } from "./backends/redis.js";
