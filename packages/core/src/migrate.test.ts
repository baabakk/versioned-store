// Tests for M7 cross-backend migration (design 08 M7). Proves a hash-verified move across every LOCAL
// backend (InMemory / SQLite / File / Postgres via pg-mem / Redis via ioredis-mock), a full chain, and
// idempotent re-import. Live Mongo is not exercised here (needs a server; see TD-VS-01/-02).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { newDb } from "pg-mem";
import RedisMock from "ioredis-mock";
import type { VersionedStoreBackend } from "./backend.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { createSqliteBackend } from "./backends/sqlite.js";
import { createPostgresBackend } from "./backends/postgres.js";
import { createFileBackend } from "./backends/file.js";
import { createRedisBackend, type RedisLike } from "./backends/redis.js";
import { exportBackend, migrate } from "./migrate.js";

let seq = 0;
const MAKERS: Record<string, () => VersionedStoreBackend> = {
  InMemory: () => createInMemoryBackend(),
  SQLite: () => createSqliteBackend(":memory:"),
  File: () => createFileBackend(mkdtempSync(join(tmpdir(), "vstore-mig-"))),
  Postgres: () => {
    const { Pool } = newDb().adapters.createPg();
    return createPostgresBackend(new Pool());
  },
  Redis: () => createRedisBackend(new RedisMock() as unknown as RedisLike, `mig${seq++}`),
};

async function seed(b: VersionedStoreBackend): Promise<void> {
  await b.init();
  await b.insertVersion({ key: "greeting", version: 1, sha256: "h-g1", createdAtIso: "t1", createdBy: "u", text: "hi" });
  await b.insertVersion({ key: "greeting", version: 2, sha256: "h-g2", createdAtIso: "t2", createdBy: "u", text: "hello" });
  await b.insertVersion({ key: "farewell", version: 1, sha256: "h-f1", createdAtIso: "t3", createdBy: "u", text: "bye" });
  await b.upsertLabel({ key: "greeting", label: "active", version: 2, promotedAtIso: "t2", promotedBy: "u" });
  await b.upsertLabel({ key: "farewell", label: "active", version: 1, promotedAtIso: "t3", promotedBy: "u" });
}

describe("M7 cross-backend migration (hash-verified)", () => {
  for (const srcName of Object.keys(MAKERS)) {
    test(`${srcName} -> SQLite migrates cleanly with matching hashes`, async () => {
      const src = MAKERS[srcName]();
      await seed(src);
      const dst = createSqliteBackend(":memory:");
      const report = await migrate(src, dst);
      assert.deepEqual(report.hashMismatches, [], "no hash mismatches");
      assert.deepEqual(report.missingOnTarget, [], "nothing missing on target");
      assert.equal(report.versions, 3);
      assert.equal(report.labels, 2);
      assert.equal(report.keys, 2);
      assert.equal((await dst.getVersion("greeting", 2))?.sha256, "h-g2");
      assert.equal((await dst.getLabel("greeting", "active"))?.version, 2);
      assert.deepEqual(await dst.distinctKeys(), ["farewell", "greeting"]);
    });
  }

  test("a chain InMemory -> SQLite -> File -> Postgres -> Redis preserves content hashes end-to-end", async () => {
    const chain = ["InMemory", "SQLite", "File", "Postgres", "Redis"];
    let cur = MAKERS[chain[0]]();
    await seed(cur);
    for (let i = 1; i < chain.length; i++) {
      const next = MAKERS[chain[i]]();
      const report = await migrate(cur, next);
      assert.deepEqual(report.hashMismatches, [], `${chain[i - 1]} -> ${chain[i]} hashes`);
      assert.deepEqual(report.missingOnTarget, [], `${chain[i - 1]} -> ${chain[i]} completeness`);
      cur = next;
    }
    const finalBundle = await exportBackend(cur);
    assert.equal(finalBundle.versions.length, 3);
    const g2 = finalBundle.versions.find((v) => v.key === "greeting" && v.version === 2);
    assert.equal(g2?.sha256, "h-g2");
    assert.equal(g2?.text, "hello");
  });

  test("re-migrating is idempotent (immutable versions skip, no error, still clean)", async () => {
    const src = createSqliteBackend(":memory:");
    await seed(src);
    const dst = createFileBackend(mkdtempSync(join(tmpdir(), "vstore-mig-idem-")));
    const r1 = await migrate(src, dst);
    const r2 = await migrate(src, dst);
    assert.deepEqual(r1.hashMismatches, []);
    assert.deepEqual(r2.hashMismatches, []);
    assert.deepEqual(r2.missingOnTarget, []);
    assert.equal((await dst.listVersionsDesc("greeting")).length, 2);
  });
});
