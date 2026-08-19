// Live-backend conformance (TD-VS-01 evidence half; beta.0 gate #4). The mock conformance in store.test.ts
// runs on a single JS event loop, which CANNOT exhibit the multi-connection race the CAS/immutability guarantee
// exists for. This file runs the SAME exported conformance suite against REAL servers (Postgres, Mongo, Redis),
// where insertVersion contention hits distinct connections and the unique-constraint conflict is genuine.
//
// It is ENV-GATED: each backend runs only when its connection env var is set, so a contributor's `npm test`
// (no env) registers nothing here and is unchanged. The CI `live-conformance` job sets the env vars against
// service containers and runs `npm run test:live`.
//
// ISOLATION: each `make()` gets its OWN scratch namespace (Postgres tables, Mongo collections, Redis prefix),
// keyed on pid + a per-run stamp, and everything is dropped in an `after` hook, so a live run leaves no residue
// even against a shared server. A shared client/pool is reused ACROSS make() calls on purpose: the pool's
// multiple connections are what make the concurrent-CAS test a real race rather than a single-loop simulation.

import { after } from "node:test";
import { Pool } from "pg";
import { MongoClient } from "mongodb";
import { Redis } from "ioredis";
import { createPostgresBackend } from "./backends/postgres.js";
import { createMongoBackend } from "./backends/mongo.js";
import { createRedisBackend, type RedisLike } from "./backends/redis.js";
import { runConformance } from "./conformance.js";

// A per-run stamp so two runs against the same shared server never collide. Date.now() is fine here (this is a
// test, not workflow code). Lowercase + underscores so it is a valid SQL identifier and a clean key prefix.
const RUN = `vsconf_${process.pid}_${Date.now()}`;

// ── Postgres ──────────────────────────────────────────────────────────────
const PG = process.env.VS_LIVE_PG;
if (PG) {
  const pool = new Pool({ connectionString: PG });
  const tables: string[] = [];
  let n = 0;
  runConformance("Postgres (live)", () => {
    const v = `${RUN}_v_${n}`;
    const l = `${RUN}_l_${n}`;
    n += 1;
    tables.push(v, l);
    return createPostgresBackend(pool, { versionsTable: v, labelsTable: l });
  });
  after(async () => {
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS "${t}"`);
    await pool.end();
  });
}

// ── Mongo ─────────────────────────────────────────────────────────────────
const MONGO = process.env.VS_LIVE_MONGO;
if (MONGO) {
  const client = new MongoClient(MONGO);
  const db = client.db(RUN); // a dedicated scratch DB, dropped whole at the end
  let n = 0;
  runConformance("Mongo (live)", () => {
    const v = `v_${n}`;
    const l = `l_${n}`;
    n += 1;
    // The driver connects lazily on the first operation, so no explicit connect() is needed here.
    return createMongoBackend(async () => db, v, l);
  });
  after(async () => {
    await db.dropDatabase();
    await client.close();
  });
}

// ── Redis ─────────────────────────────────────────────────────────────────
const REDIS = process.env.VS_LIVE_REDIS;
if (REDIS) {
  const redis = new Redis(REDIS, { maxRetriesPerRequest: 3, lazyConnect: false });
  const prefixes: string[] = [];
  let n = 0;
  runConformance("Redis (live)", () => {
    const prefix = `${RUN}:${n}`;
    n += 1;
    prefixes.push(prefix);
    return createRedisBackend(redis as unknown as RedisLike, prefix);
  });
  after(async () => {
    // Delete only this run's keys (SCAN + UNLINK per scratch prefix), never a FLUSHDB on a shared server.
    for (const p of prefixes) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${p}*`, "COUNT", 200);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== "0");
    }
    await redis.quit();
  });
}
