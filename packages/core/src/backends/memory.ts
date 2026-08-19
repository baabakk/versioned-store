// In-memory VersionedStoreBackend — the reference implementation of the storage contract (design 08 M1).
// Pure Maps, no I/O, no deps. It is the semantic yardstick the conformance suite runs first: if a behaviour
// (immutability via BackendConflictError, version-descending order, label upsert) is wrong here it is wrong
// everywhere. Used for tests and for a Mongo-less run; never a production backend (process-local, non-durable).
// Stored docs are deep-copied in and out so a caller mutating a returned doc cannot corrupt the store —
// matching the fresh-object semantics a real DB driver gives on every read (no aliasing surprises).

import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Create the in-memory backend: two nested `Map`s, no I/O, no dependencies. It is the reference implementation
 * of {@link VersionedStoreBackend}, so it doubles as the shortest complete reading of the storage contract when
 * you are writing an adapter of your own.
 *
 * Docs are deep-copied on the way in and on the way out, which reproduces the fresh-object semantics a real
 * driver gives on every read: a caller that mutates a returned doc cannot reach back into the store.
 *
 * State is process-local and gone on exit. That makes it right for tests, examples, and a backend-less local
 * run, and wrong for production (use SQLite, File, Postgres, Mongo, or Redis there).
 *
 * @returns A fresh, empty backend. One call per isolated store: the conformance suite depends on each factory
 * call producing an independent instance.
 *
 * @example
 * ```ts
 * import { createVersionedStore, createInMemoryBackend } from "@versioned-store/core";
 *
 * const store = createVersionedStore<{ text: string }>(
 *   {
 *     domain: "greeting",
 *     defaults: { hello: { text: "Hello!" } },
 *     hash: (v) => v.text,
 *     toDoc: (v) => ({ text: v.text }),
 *     fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
 *   },
 *   createInMemoryBackend(),
 * );
 *
 * const v1 = await store.addVersion("hello", { text: "Hi there!" });
 * await store.promote("hello", v1);
 * await store.resolve("hello"); // { version: 1, value: { text: "Hi there!" } }
 * ```
 */
export function createInMemoryBackend(): VersionedStoreBackend {
  // key -> (version -> immutable version doc); key -> (label -> movable pointer).
  const versions = new Map<string, Map<number, StoredDoc>>();
  const labels = new Map<string, Map<string, LabelDoc>>();

  return {
    async init(): Promise<void> {
      // Nothing to create — the Maps are the store. Idempotent by construction.
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      const doc = versions.get(key)?.get(version);
      return doc ? clone(doc) : null;
    },

    async maxVersion(key: string): Promise<number | null> {
      const inner = versions.get(key);
      if (!inner || inner.size === 0) return null;
      let max = -Infinity;
      for (const v of inner.keys()) if (v > max) max = v;
      return max;
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      let inner = versions.get(doc.key);
      if (!inner) {
        inner = new Map();
        versions.set(doc.key, inner);
      }
      // The check-then-set is synchronous (no await between them), so it is the atomic CAS the core relies on:
      // a second writer racing for the same (key, version) sees has()=true and gets BackendConflictError, which
      // the core catches to re-read maxVersion and retry. Immutability holds — an existing version is never
      // overwritten (design 08 §2.6, §6 Risk 3).
      if (inner.has(doc.version)) throw new BackendConflictError(doc.key, doc.version);
      inner.set(doc.version, clone(doc));
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      const inner = versions.get(key);
      if (!inner) return [];
      return [...inner.values()].sort((a, b) => b.version - a.version).map(clone);
    },

    async distinctKeys(): Promise<string[]> {
      const out: string[] = [];
      for (const [key, inner] of versions) if (inner.size > 0) out.push(key);
      return out.sort();
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      const doc = labels.get(key)?.get(label);
      return doc ? clone(doc) : null;
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      let inner = labels.get(doc.key);
      if (!inner) {
        inner = new Map();
        labels.set(doc.key, inner);
      }
      inner.set(doc.label, clone(doc));
    },
  };
}
