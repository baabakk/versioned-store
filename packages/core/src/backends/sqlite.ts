// SQLite VersionedStoreBackend via the built-in node:sqlite (Node 22+). TEST / conformance backend only —
// node:sqlite is still Stability-1 experimental even on Node 24, so it never runs in production (Mongo does).
// Its value over the InMemory reference: a real embedded SQL engine whose UNIQUE (key, version) constraint
// enforces immutability the same way Mongo's unique index does, so the conformance suite proves the CAS /
// immutability contract against genuine storage, not just Maps.
//
// Each StoredDoc / LabelDoc is stored whole as a JSON `doc` column (the payload carries arbitrary
// index-signature fields, so a fixed column set will not do), with (key, version) / (key, label) mirrored
// into the indexed PRIMARY KEY for lookup + ordering. The node:sqlite API is synchronous (DatabaseSync); the
// contract is async, so the methods just wrap the sync calls.

import { DatabaseSync } from "node:sqlite";
import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

const DDL = `
  CREATE TABLE IF NOT EXISTS versions (
    key     TEXT    NOT NULL,
    version INTEGER NOT NULL,
    doc     TEXT    NOT NULL,
    PRIMARY KEY (key, version)
  );
  CREATE TABLE IF NOT EXISTS labels (
    key   TEXT NOT NULL,
    label TEXT NOT NULL,
    doc   TEXT NOT NULL,
    PRIMARY KEY (key, label)
  );
`;

/** SQLite raises "UNIQUE constraint failed: versions.key, versions.version" on a re-insert; our CAS signal. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** @param location a file path, or ":memory:" (default) for an ephemeral per-instance DB (tests). */
export function createSqliteBackend(location = ":memory:"): VersionedStoreBackend {
  const db = new DatabaseSync(location);
  // Eager: tables exist the moment the backend is constructed, so a read before an explicit init() cannot hit
  // "no such table" (Mongo tolerates querying an unseeded collection; this keeps SQLite equally forgiving).
  db.exec(DDL);

  return {
    async init(): Promise<void> {
      db.exec(DDL); // idempotent re-run (IF NOT EXISTS)
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      const row = db.prepare("SELECT doc FROM versions WHERE key = ? AND version = ?").get(key, version);
      return row ? (JSON.parse(row.doc as string) as StoredDoc) : null;
    },

    async maxVersion(key: string): Promise<number | null> {
      const row = db.prepare("SELECT MAX(version) AS m FROM versions WHERE key = ?").get(key);
      const m = row?.m;
      return typeof m === "number" ? m : typeof m === "bigint" ? Number(m) : null;
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      try {
        db.prepare("INSERT INTO versions (key, version, doc) VALUES (?, ?, ?)").run(
          doc.key,
          doc.version,
          JSON.stringify(doc),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new BackendConflictError(doc.key, doc.version);
        throw err;
      }
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      const rows = db.prepare("SELECT doc FROM versions WHERE key = ? ORDER BY version DESC").all(key);
      return rows.map((r) => JSON.parse(r.doc as string) as StoredDoc);
    },

    async distinctKeys(): Promise<string[]> {
      const rows = db.prepare("SELECT DISTINCT key FROM versions ORDER BY key").all();
      return rows.map((r) => r.key as string);
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      const row = db.prepare("SELECT doc FROM labels WHERE key = ? AND label = ?").get(key, label);
      return row ? (JSON.parse(row.doc as string) as LabelDoc) : null;
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      db.prepare(
        "INSERT INTO labels (key, label, doc) VALUES (?, ?, ?) ON CONFLICT (key, label) DO UPDATE SET doc = excluded.doc",
      ).run(doc.key, doc.label, JSON.stringify(doc));
    },
  };
}
