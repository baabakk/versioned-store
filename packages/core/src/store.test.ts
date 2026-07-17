// Runs the exported conformance suite (conformance.ts) against all FIVE local backends: InMemory + SQLite +
// Postgres (pg-mem) + File + Redis (ioredis-mock). Mongo is excluded here (needs a live server); its adapter
// is a verbatim lift and is covered by production. A third party certifies its own adapter the same way, by
// importing runConformance and calling it against its factory. Run: `npm test`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import RedisMock from "ioredis-mock";
import type { VersionedStoreBackend } from "./backend.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { createSqliteBackend } from "./backends/sqlite.js";
import { createPostgresBackend } from "./backends/postgres.js";
import { createFileBackend } from "./backends/file.js";
import { createRedisBackend, type RedisLike } from "./backends/redis.js";
import { runConformance } from "./conformance.js";

// A unique prefix per Redis backend instance isolates them within ioredis-mock's shared keyspace.
let redisSeq = 0;

const BACKENDS: Array<[string, () => VersionedStoreBackend]> = [
  ["InMemory", () => createInMemoryBackend()],
  ["SQLite", () => createSqliteBackend(":memory:")],
  // Postgres against an in-memory pg-mem Pool (fresh DB per factory call); real PG runs the same adapter.
  [
    "Postgres (pg-mem)",
    () => {
      const { Pool } = newDb().adapters.createPg();
      return createPostgresBackend(new Pool());
    },
  ],
  // File backend over a fresh temp dir per factory call (real fs, OS-level wx immutability).
  ["File", () => createFileBackend(mkdtempSync(join(tmpdir(), "vstore-file-")))],
  // Redis against ioredis-mock (unique prefix per instance); real Redis runs the same adapter + atomic Lua.
  ["Redis (ioredis-mock)", () => createRedisBackend(new RedisMock() as unknown as RedisLike, `vs${redisSeq++}`)],
];

for (const [name, make] of BACKENDS) runConformance(name, make);
