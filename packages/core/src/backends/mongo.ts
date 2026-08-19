// Mongo VersionedStoreBackend — the PRODUCTION backend (the only one that runs on the server). It lifts the
// exact Mongo operations the versioned-store core used to inline, behind the storage contract, with NO change
// to the on-disk shape: immutable versions in `versionsCollection` (unique index (key, version)) and movable
// label pointers in `labelsCollection` (unique index (key, label)). Immutability is the unique index; a racing
// duplicate insert surfaces as E11000, re-thrown as BackendConflictError (the core's CAS signal). Mongo's own
// `_id` is stripped on read so a returned doc matches the contract shape (and the InMemory / SQLite adapters)
// exactly. Mongo-configured vs code-default is the CORE's decision (isMongoConfigured); this backend is only
// ever reached when Mongo is live, so it assumes getDb() resolves — storage only, no fallback policy here.

import type { Db } from "mongodb";
import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

/** Mongo raises E11000 on a unique-index violation; that is our version-bump CAS-conflict signal. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/** Drop Mongo's `_id` so the returned doc is exactly the contract shape (parity with InMemory / SQLite). */
function stripId<T>(doc: (T & { _id?: unknown }) | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest as T;
}

/**
 * Create the Mongo backend over two collections: immutable version docs in one, movable label pointers in the
 * other. It is a thin translation of the storage contract into Mongo operations with no change to the on-disk
 * shape, so an existing pair of collections can be adopted as they stand, with no data migration.
 *
 * Immutability rides on the unique `(key, version)` index that `init()` creates: a racing duplicate insert
 * comes back as E11000 and is re-thrown as {@link BackendConflictError} for the core's retry. Since the index
 * is what enforces it, `init()` (reachable as `store.ensureIndexes()`) must have run against the database
 * before concurrent writers are trusted. Mongo's own `_id` is stripped on read, so a returned doc is exactly
 * the contract shape and matches what the InMemory and SQLite adapters return.
 *
 * Import from the `@versioned-store/core/backends/mongo` subpath: the main entry stays free of `mongodb`.
 *
 * @param getDb Resolver for a live `Db`. It is a function rather than a `Db` so the host keeps ownership of the
 * connection lifecycle (lazy connect, reconnect, pooling) and this adapter never opens one. It is called only
 * when an operation actually runs, and it is assumed to resolve: whether Mongo is configured at all is the
 * core's decision through the config's `backendAvailable` probe, not this adapter's, which does storage only.
 * @param versionsCollection Collection holding the immutable version docs.
 * @param labelsCollection Collection holding the label pointers.
 *
 * @example
 * ```ts
 * import { createVersionedStore } from "@versioned-store/core";
 * import { createMongoBackend } from "@versioned-store/core/backends/mongo";
 * import { getDb, isMongoConfigured } from "./infra.js";
 *
 * const store = createVersionedStore<Prompt>(
 *   { ...promptCfg, backendAvailable: isMongoConfigured }, // serve code defaults when Mongo is absent
 *   createMongoBackend(getDb, "prompt_versions", "prompt_labels"),
 * );
 *
 * await store.ensureIndexes(); // unique (key,version) + (key,label); run once at boot
 * ```
 */
export function createMongoBackend(getDb: () => Promise<Db>, versionsCollection: string, labelsCollection: string): VersionedStoreBackend {
  const versions = async () => (await getDb()).collection<StoredDoc>(versionsCollection);
  const labels = async () => (await getDb()).collection<LabelDoc>(labelsCollection);

  return {
    async init(): Promise<void> {
      await (await versions()).createIndex({ key: 1, version: 1 }, { unique: true });
      await (await labels()).createIndex({ key: 1, label: 1 }, { unique: true });
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      return stripId<StoredDoc>(await (await versions()).findOne({ key, version }));
    },

    async maxVersion(key: string): Promise<number | null> {
      const doc = await (await versions()).findOne({ key }, { sort: { version: -1 }, projection: { version: 1 } });
      return doc && typeof doc.version === "number" ? doc.version : null;
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      try {
        // Copy so the driver's in-place `_id` assignment does not mutate the caller's doc.
        await (await versions()).insertOne({ ...doc });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new BackendConflictError(doc.key, doc.version);
        throw err;
      }
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      const docs = await (await versions()).find({ key }).sort({ version: -1 }).toArray();
      return docs.map((d) => stripId<StoredDoc>(d) as StoredDoc);
    },

    async distinctKeys(): Promise<string[]> {
      return ((await (await versions()).distinct("key")) as string[]).sort();
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      return stripId<LabelDoc>(await (await labels()).findOne({ key, label }));
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      await (await labels()).updateOne({ key: doc.key, label: doc.label }, { $set: { ...doc } }, { upsert: true });
    },
  };
}
