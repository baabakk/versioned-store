// Postgres VersionedStoreBackend (design 08 M4). Takes an INJECTED `pg` Pool, so the caller owns the
// connection + config (and tests inject an in-memory pg-mem Pool). `pg` itself is not a runtime dependency
// of this module — only the Pool TYPE is imported (erased at runtime); production passes its own pg Pool.
//
// Immutable versions live in `versions` with PRIMARY KEY (key, version): a re-insert hits SQLSTATE 23505
// (unique_violation) -> BackendConflictError (the core's CAS signal), exactly like Mongo's unique index and
// SQLite's PK. Movable labels live in `labels` (PRIMARY KEY (key, label)), upserted via ON CONFLICT DO
// UPDATE. Each StoredDoc/LabelDoc is stored whole in a `doc` text column (arbitrary payload fields); the
// indexed (key, version) PK gives native version ordering (MAX / ORDER BY version).
//
// The DDL is memoized per instance (`ensureReady`) and every method awaits it, so the tables exist before
// any op (matching SQLite's eager creation) and the DDL runs exactly once — cheap on real PG, and it avoids
// re-running CREATE TABLE, which is what a strict in-memory PG (pg-mem) trips on.

import type { Pool } from "pg";
import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

/** Postgres raises SQLSTATE 23505 (unique_violation) on a re-insert; our CAS-conflict signal. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string };
  return e.code === "23505" || /duplicate key value|violates unique constraint/i.test(e.message ?? "");
}

export function createPostgresBackend(pool: Pool): VersionedStoreBackend {
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> =>
    (ready ??= (async () => {
      await pool.query("CREATE TABLE IF NOT EXISTS versions (key text NOT NULL, version integer NOT NULL, doc text NOT NULL, PRIMARY KEY (key, version))");
      await pool.query("CREATE TABLE IF NOT EXISTS labels (key text NOT NULL, label text NOT NULL, doc text NOT NULL, PRIMARY KEY (key, label))");
    })());

  return {
    async init(): Promise<void> {
      await ensureReady();
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      await ensureReady();
      const res = await pool.query<{ doc: string }>("SELECT doc FROM versions WHERE key = $1 AND version = $2", [key, version]);
      return res.rows[0] ? (JSON.parse(res.rows[0].doc) as StoredDoc) : null;
    },

    async maxVersion(key: string): Promise<number | null> {
      await ensureReady();
      const res = await pool.query<{ m: number | string | null }>("SELECT MAX(version) AS m FROM versions WHERE key = $1", [key]);
      const m = res.rows[0]?.m;
      return m == null ? null : Number(m); // pg returns int4 as number; coerce defensively (drivers vary)
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      await ensureReady();
      try {
        await pool.query("INSERT INTO versions (key, version, doc) VALUES ($1, $2, $3)", [doc.key, doc.version, JSON.stringify(doc)]);
      } catch (err) {
        if (isUniqueViolation(err)) throw new BackendConflictError(doc.key, doc.version);
        throw err;
      }
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      await ensureReady();
      const res = await pool.query<{ doc: string }>("SELECT doc FROM versions WHERE key = $1 ORDER BY version DESC", [key]);
      return res.rows.map((r) => JSON.parse(r.doc) as StoredDoc);
    },

    async distinctKeys(): Promise<string[]> {
      await ensureReady();
      const res = await pool.query<{ key: string }>("SELECT DISTINCT key FROM versions ORDER BY key ASC");
      return res.rows.map((r) => r.key);
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      await ensureReady();
      const res = await pool.query<{ doc: string }>("SELECT doc FROM labels WHERE key = $1 AND label = $2", [key, label]);
      return res.rows[0] ? (JSON.parse(res.rows[0].doc) as LabelDoc) : null;
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      await ensureReady();
      await pool.query(
        "INSERT INTO labels (key, label, doc) VALUES ($1, $2, $3) ON CONFLICT (key, label) DO UPDATE SET doc = EXCLUDED.doc",
        [doc.key, doc.label, JSON.stringify(doc)],
      );
    },
  };
}
