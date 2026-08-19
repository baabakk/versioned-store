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
  /** Optional operator-supplied reason for this promotion (e.g. "rollback: v7 regressed cue quality"). */
  note?: string;
  /** Consumer-owned trace metadata stamped at promote (same value emitted on the promote-accepted event). */
  refs?: Record<string, unknown>;
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

/**
 * The pluggable storage contract behind `createVersionedStore`: eight methods over two logical tables, one of
 * immutable versions (unique on `(key, version)`) and one of movable label pointers (unique on `(key, label)`).
 * This is the interface a third-party adapter implements, and its smallness is the point. The core owns every
 * policy decision (code-default fallback, version cache, optimistic-CAS retry, the eval-gate on promote, seed
 * and sync, the fallback alarm), so an adapter carries no domain branch and no policy opinion of its own: it
 * does storage, nothing else.
 *
 * A backend is always INJECTED by the host (`createVersionedStore(cfg, myBackend)`). The core never constructs
 * one, which is why the core package depends on no driver and why swapping storage is a one-line change at the
 * single construction site.
 *
 * ## What an implementation must guarantee
 *
 * 1. **Versions are immutable.** No method here overwrites or deletes a stored `(key, version)`.
 *    `insertVersion` MUST throw {@link BackendConflictError} when that pair already exists, and MUST leave the
 *    existing doc byte-for-byte untouched. That specific throw is the compare-and-swap signal the core's retry
 *    loop is built on: it catches the conflict, re-reads `maxVersion`, and retries the bump, which is what stops
 *    two concurrent writers from both claiming the same version number. An adapter that silently overwrites, or
 *    that reports the clash as a generic `Error`, breaks version identity under concurrency and will be caught
 *    by the conformance suite's concurrent-CAS test.
 * 2. **The conflict check is atomic.** The existence check and the write must not be separable by another
 *    writer. A server database gets this from a unique index (Mongo raises E11000, Postgres raises 23505); the
 *    file adapter gets it from the kernel (`wx`, i.e. `O_CREAT | O_EXCL`); a KV adapter has to synthesize it
 *    (the Redis one runs a single Lua script). However it is obtained, two racing inserts for one
 *    `(key, version)` must leave exactly one winner.
 * 3. **The payload round-trips.** `StoredDoc` carries arbitrary domain fields through its index signature,
 *    nested objects and arrays included. Whatever goes into `insertVersion` must come back out of `getVersion`
 *    and `listVersionsDesc` unchanged, minus any storage-engine artifact the adapter is responsible for hiding
 *    (the Mongo adapter strips `_id` for exactly this reason, so every backend returns the same shape).
 * 4. **Ordering is the backend's job.** `listVersionsDesc` returns version-descending, `distinctKeys` returns
 *    ascending string-sorted keys. Callers depend on both rather than re-sorting.
 * 5. **Labels are the only mutable rows.** `upsertLabel` overwrites in place, because moving a pointer is what
 *    a promote or a rollback IS. Optional `note` and `refs` must survive the round trip, since they are the
 *    audit trail of who promoted what and why.
 * 6. **`init` is idempotent.** Re-running it against a populated store must neither throw nor wipe anything;
 *    hosts call it on every boot.
 *
 * ## Certifying an implementation
 *
 * The list above is not meant to be checked by eye: `runConformance` from `@versioned-store/core/conformance`
 * is its executable form, and it is the same suite the built-in adapters run. It exercises the storage contract
 * directly, then runs the core's policy over the adapter (including the concurrent-CAS case). Green means the
 * adapter honours immutability, compare-and-swap, version ordering, and labels, and the core's guarantees hold
 * on top of it.
 *
 * @example
 * ```ts
 * // certify a new adapter (run under `node --test`)
 * import { runConformance } from "@versioned-store/core/conformance";
 *
 * runConformance("MyBackend", () => createMyBackend(freshNamespace())); // factory must return a FRESH store
 * ```
 *
 * @example
 * ```ts
 * // then inject it, like any built-in backend
 * import { createVersionedStore } from "@versioned-store/core";
 *
 * const store = createVersionedStore<Prompt>(promptCfg, createMyBackend(conn));
 * await store.ensureIndexes(); // calls init(); safe on every boot
 * ```
 */
export interface VersionedStoreBackend {
  /**
   * Create the tables/indexes (unique (key,version) + unique (key,label)). Idempotent; safe to re-run.
   * Where immutability is enforced by an index rather than by the storage medium (Mongo, Postgres), this is
   * what installs that enforcement, so it must have run once against the store before concurrent writers are
   * trusted. Hosts reach it through `store.ensureIndexes()`.
   */
  init(): Promise<void>;
  /**
   * The stored version doc for (key, version), or null.
   * @returns The doc as written (any storage-engine field such as Mongo's `_id` stripped), or null when that
   * version does not exist. Never throws for a missing version: absence is a value, not an error.
   */
  getVersion(key: string, version: number): Promise<StoredDoc | null>;
  /**
   * The highest version number for a key, or null when the key has no versions yet.
   * @returns Null and 0 are different answers: null means nothing is stored (the core's next insert is v1),
   * while 0 would be a stored version. The core reads this immediately before each insert attempt and again
   * after every conflict, so it must reflect committed writes rather than a cached value.
   */
  maxVersion(key: string): Promise<number | null>;
  /**
   * Insert a new immutable version. MUST throw {@link BackendConflictError} if (key, version) exists.
   * The check and the write must be atomic with respect to other writers, and an existing doc must be left
   * exactly as it was. This throw is the core's only conflict signal: any other error type propagates out of
   * `addVersion` instead of triggering the version-bump retry.
   */
  insertVersion(doc: StoredDoc): Promise<void>;
  /** All versions of a key, version-descending. Returns an empty array for an unknown key, never null. */
  listVersionsDesc(key: string): Promise<StoredDoc[]>;
  /** Every distinct key that has at least one version, in ascending (string-sorted) order. */
  distinctKeys(): Promise<string[]>;
  /** The label pointer for (key, label), or null. An unset label is null, not a pointer at version 0. */
  getLabel(key: string, label: string): Promise<LabelDoc | null>;
  /**
   * Upsert the label pointer (the promote/rollback write, and the only mutable row in the store). Overwriting is
   * correct here and only here. The optional `note` and `refs` must persist and come back through `getLabel`,
   * because they carry the operator's reason for the flip.
   */
  upsertLabel(doc: LabelDoc): Promise<void>;
}
