// ---------------------------------------------------------------------------
// The pluggable storage contract for createVersionedStore (design 08 M1). A backend stores two logical
// tables per domain — immutable versions (unique on (key, version)) and movable label pointers (unique on
// (key, label)) — behind ~8 methods. The versioned-store CORE owns all policy (code-default fallback,
// version cache, optimistic-CAS retry, eval-gate on promote, seed/sync, fallback alarm); a backend does
// storage only, with no domain branches. The same core + the same conformance suite run across every
// backend (Mongo in production; SQLite / InMemory in tests). This is what makes the store storage-portable.
// ---------------------------------------------------------------------------

import { VersionedStoreError } from "./errors.js";

/** A stored immutable version: the metadata the core owns + the domain payload fields (index signature). */
export interface StoredDoc {
  key: string;
  version: number;
  sha256: string;
  createdAtIso: string;
  createdBy: string;
  note?: string;
  [field: string]: unknown;
}

/** A movable label pointer (e.g. `active` -> v3). Unique on (key, label). */
export interface LabelDoc {
  key: string;
  label: string;
  version: number;
  promotedAtIso: string;
  promotedBy: string;
}

/**
 * Thrown by `insertVersion` when (key, version) already exists. This is the core's optimistic-CAS conflict
 * signal: on catch, the core re-reads `maxVersion` and retries the bump. Every backend MUST raise this
 * (never overwrite) so immutability holds under concurrency — the one guarantee server DBs get for free and
 * a KV backend must synthesize (design 08 §2.6, §6 Risk 3).
 */
export class BackendConflictError extends VersionedStoreError {
  constructor(public readonly key: string, public readonly version: number) {
    super(`version conflict: ${key} v${version} already exists`);
    this.name = "BackendConflictError";
  }
}

export interface VersionedStoreBackend {
  /** Create the tables/indexes (unique (key,version) + unique (key,label)). Idempotent; safe to re-run. */
  init(): Promise<void>;
  /** The stored version doc for (key, version), or null. */
  getVersion(key: string, version: number): Promise<StoredDoc | null>;
  /** The highest version number for a key, or null when the key has no versions yet. */
  maxVersion(key: string): Promise<number | null>;
  /** Insert a new immutable version. MUST throw {@link BackendConflictError} if (key, version) exists. */
  insertVersion(doc: StoredDoc): Promise<void>;
  /** All versions of a key, version-descending. */
  listVersionsDesc(key: string): Promise<StoredDoc[]>;
  /** Every distinct key that has at least one version, in ascending (string-sorted) order. */
  distinctKeys(): Promise<string[]>;
  /** The label pointer for (key, label), or null. */
  getLabel(key: string, label: string): Promise<LabelDoc | null>;
  /** Upsert the label pointer (the promote/rollback write — the only mutable row in the store). */
  upsertLabel(doc: LabelDoc): Promise<void>;
}
