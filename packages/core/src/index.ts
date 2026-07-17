// Public API barrel for @babak/versioned-store (design 08 M14/M16). The main entry exports the core, all
// tooling, and the driver-free backends (InMemory, File, and Redis via an injected client). SQLite
// (node:sqlite, Node 22+), Postgres, and Mongo are SUBPATH exports, so importing the main barrel never loads
// node:sqlite / pg / mongodb and the core entry stays Node-18-safe:
//   import { createSqliteBackend }   from "@babak/versioned-store/backends/sqlite"    // node:sqlite (Node 22+)
//   import { createPostgresBackend } from "@babak/versioned-store/backends/postgres"  // needs `pg`
//   import { createMongoBackend }    from "@babak/versioned-store/backends/mongo"      // needs `mongodb`

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
export { run as runCli, backendFromSpec } from "./cli.js";

// Driver-free backends, safe in the main entry. SQLite / Postgres / Mongo are subpath-only (see the header).
export { createInMemoryBackend } from "./backends/memory.js";
export { createFileBackend } from "./backends/file.js";
export { createRedisBackend, type RedisLike } from "./backends/redis.js";
