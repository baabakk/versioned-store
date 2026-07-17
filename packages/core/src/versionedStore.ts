import { emitStoreEvent, recordFallback, STORE_EVENT_SCHEMA_VERSION } from "./events.js";
import { BackendConflictError, type StoredDoc, type VersionedStoreBackend } from "./backend.js";
import { storeLog } from "./logger.js";
import { CasExhaustedError, GateRejectedError, VersionNotFoundError } from "./errors.js";

/** Max optimistic-CAS retries on the version bump before giving up (a hot-loop bound, never hit in practice). */
const MAX_CAS_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// A generic, immutable-versioned, label-pointer store. This is the shared core the design (06 doc §12)
// extracts from the two near-identical hand-written stores (prompts + scaffolds): the same resolve-by-label-
// to-version, code-default fallback, immutable addVersion, promote (pointer flip), version cache, seed/sync.
// Everything domain-specific (rendering, routing, validation, the on-disk payload shape, null-vs-throw policy)
// stays in the domain module and is injected as config -> no `if (domain === ...)` branches (wrong-abstraction
// guardrail). The payload T is mapped to/from the stored doc via toDoc/fromDoc so each domain KEEPS its exact
// on-disk shape with no data migration.
//
// STORAGE PORTABILITY (design 08 M1/M13): the core owns all policy but delegates every read/write to an
// INJECTED `VersionedStoreBackend` (backend.ts). It never constructs a backend itself, so it carries no
// backend-specific dependency; the host composes and injects one. The optimistic-CAS retry lives HERE
// (keyed on the backend-agnostic `BackendConflictError`), so immutability-under-concurrency holds for every
// backend, not just Mongo.
// ---------------------------------------------------------------------------

export interface Resolved<T> {
  key: string;
  version: number;   // 0 = the in-code default (sentinel)
  sha256: string;
  value: T;
}

/** The outcome of an eval-gate: a promote is refused when `passed` is false, surfacing `failures`. */
export interface GateResult {
  passed: boolean;
  failures: string[];
}

/** An eval-gate hook run at promote time. Sync (deterministic tier) or async (golden-output / LLM-judge, M6). */
export type Gate<T> = (value: T) => GateResult | Promise<GateResult>;

export interface VersionInfo {
  version: number;
  sha256: string;
  createdAtIso: string;
  createdBy: string;
  note?: string;
  active: boolean;
}

export interface KeySummary {
  key: string;
  activeVersion: number | null;
  versions: number;
}

export interface VersionedStoreConfig<T> {
  /** Short domain id for logs + fallback metrics (e.g. "prompt", "scaffold"). */
  domain: string;
  /** The default label value (usually "active"). */
  defaultLabel?: string;
  /**
   * Optional availability probe. When provided and it returns false, `resolve` short-circuits to the code
   * default (a "backend-unavailable" fallback, debug-level) WITHOUT touching the backend, so a host can wire
   * e.g. `isMongoConfigured` to serve code defaults quietly on a backend-less local run. Omit it and the
   * backend is always attempted (the offline fallback still holds via `resolve`'s catch).
   */
  backendAvailable?: () => boolean;
  /** Code defaults: the single source for BOTH the backend-down/missing fallback AND the seed. */
  defaults: Record<string, T>;
  /** Content hash of a value (used for version identity + sync change-detection). */
  hash: (value: T) => string;
  /** Payload -> the extra doc fields written on insert (preserves the domain's on-disk shape). */
  toDoc: (value: T) => Record<string, unknown>;
  /** Stored doc -> payload; return null when the doc is malformed/invalid (triggers a fallback). */
  fromDoc: (doc: Record<string, unknown>) => T | null;
  /** Optional validation applied before an insert (throws on invalid); used by add + seed + sync. */
  validate?: (value: T) => T;
  /**
   * When true, falling back to the code default is a FIRST-CLASS path (e.g. the Scaffold Store, where a
   * routed-but-unseeded key legitimately uses the in-code spec), so label/doc-missing fallbacks log at
   * debug instead of WARN. Leave false for prompts, where a fallback means a prompt that should be
   * seeded is not (a genuine alarm). Real anomalies (resolve-error, schema-invalid) always WARN.
   */
  codeDefaultIsFirstClass?: boolean;
}

export interface VersionedStore<T> {
  /** Run-time resolve: label -> version with code-default fallback (+ fallback alarm) + version cache. */
  resolve(key: string, label?: string): Promise<Resolved<T> | null>;
  /** Read a specific stored version's value. No code-default fallback (admin/display path). */
  getVersion(key: string, version: number): Promise<Resolved<T> | null>;
  /** Read the value the active label points to. No code-default fallback (admin/display path). */
  getActiveVersion(key: string, label?: string): Promise<Resolved<T> | null>;
  /** Insert a NEW immutable version (never overwrites); returns the new version number. Admin only. */
  addVersion(key: string, value: T, opts?: { by?: string; note?: string }): Promise<number>;
  /** Flip the movable label to an existing version, optionally gated. The explicit deploy/rollback verb. */
  promote(key: string, version: number, opts?: { label?: string; by?: string; gate?: Gate<T>; refs?: Record<string, unknown> }): Promise<void>;
  listVersions(key: string): Promise<VersionInfo[]>;
  listKeys(): Promise<KeySummary[]>;
  ensureIndexes(): Promise<void>;
  /** Idempotent: for each code default not yet in the store, insert it as v1 and set active -> 1. */
  seedDefaults(): Promise<Array<{ key: string; seeded: boolean }>>;
  /** For each code default whose content differs from the active version (or is unseeded), add + promote. */
  syncDefaults(): Promise<Array<{ key: string; action: "seeded" | "updated" | "unchanged" }>>;
  /** The in-code default as a Resolved (sentinel version 0), or null when the key has no default. */
  codeDefault(key: string): Resolved<T> | null;
}

/**
 * @param cfg the domain configuration (payload mapping, defaults, hash, optional availability probe).
 * @param backend the storage backend (InMemory / SQLite / File / Postgres / Redis / Mongo). Required: the
 *   store never constructs a backend itself, so it has no backend-specific dependency. The host composes the
 *   backend (e.g. `createMongoBackend(() => getDb(), "prompts", "prompt_labels")`) and injects it here.
 */
export function createVersionedStore<T>(cfg: VersionedStoreConfig<T>, backend: VersionedStoreBackend): VersionedStore<T> {
  const log = storeLog(`store:${cfg.domain}`);
  const DEFAULT_LABEL = cfg.defaultLabel ?? "active";
  // Versions are immutable, so a cached entry can never go stale (effectively infinite TTL, no split-brain).
  const cache = new Map<string, Resolved<T>>();

  function codeDefault(key: string): Resolved<T> | null {
    const d = cfg.defaults[key];
    if (d === undefined) return null;
    return { key, version: 0, sha256: cfg.hash(d), value: d };
  }

  function validate(value: T): T {
    return cfg.validate ? cfg.validate(value) : value;
  }

  function docToResolved(key: string, doc: StoredDoc): Resolved<T> | null {
    const value = cfg.fromDoc(doc);
    if (value === null) return null;
    return { key, version: doc.version, sha256: doc.sha256 ?? cfg.hash(value), value };
  }

  async function resolve(key: string, label = DEFAULT_LABEL): Promise<Resolved<T> | null> {
    if (cfg.backendAvailable && !cfg.backendAvailable()) {
      recordFallback(cfg.domain, key, "backend-unavailable");
      return codeDefault(key);
    }
    try {
      const ptr = await backend.getLabel(key, label);
      if (!ptr || typeof ptr.version !== "number") {
        recordFallback(cfg.domain, key, "label-missing", { alarm: !cfg.codeDefaultIsFirstClass, extra: { label } });
        return codeDefault(key);
      }
      const cacheKey = `${key}:v${ptr.version}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const doc = await backend.getVersion(key, ptr.version);
      if (!doc) {
        recordFallback(cfg.domain, key, "doc-missing", { alarm: !cfg.codeDefaultIsFirstClass, extra: { version: ptr.version } });
        return codeDefault(key);
      }
      const resolved = docToResolved(key, doc);
      if (!resolved) {
        // A stored value failing validation is a real anomaly, so it always alarms (even for scaffolds).
        recordFallback(cfg.domain, key, "schema-invalid", { extra: { version: ptr.version } });
        return codeDefault(key);
      }
      cache.set(cacheKey, resolved);
      return resolved;
    } catch (err) {
      recordFallback(cfg.domain, key, "resolve-error", { extra: { label, err: err instanceof Error ? err.message : String(err) } });
      return codeDefault(key);
    }
  }

  async function getVersion(key: string, version: number): Promise<Resolved<T> | null> {
    const doc = await backend.getVersion(key, version);
    return doc ? docToResolved(key, doc) : null;
  }

  async function getActiveVersion(key: string, label = DEFAULT_LABEL): Promise<Resolved<T> | null> {
    const ptr = await backend.getLabel(key, label);
    if (!ptr || typeof ptr.version !== "number") return null;
    return getVersion(key, ptr.version);
  }

  async function addVersion(key: string, value: T, opts: { by?: string; note?: string } = {}): Promise<number> {
    const v = validate(value);
    // Optimistic CAS on the version bump, backend-agnostic. The unique (key, version) constraint prevents
    // corruption; a concurrent writer who grabbed the same version makes the loser's insertVersion throw
    // BackendConflictError -> the loser re-reads maxVersion and retries, so addVersion is safe under concurrency
    // on ANY backend (design 06 §10.3 / 08 §3 req 2 / §6 Risk 3; closes TD-PS-06). Also makes seed/sync robust
    // to a racing edit.
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const max = await backend.maxVersion(key);
      const version = (max ?? 0) + 1;
      const doc: StoredDoc = {
        key,
        version,
        ...cfg.toDoc(v),
        sha256: cfg.hash(v),
        createdAtIso: new Date().toISOString(),
        createdBy: opts.by ?? "admin",
        note: opts.note,
      };
      try {
        await backend.insertVersion(doc);
        log.info({ key, version, by: opts.by ?? "admin" }, "version added");
        return version;
      } catch (err) {
        if (err instanceof BackendConflictError && attempt < MAX_CAS_ATTEMPTS) {
          log.debug({ key, version, attempt }, "addVersion CAS conflict — another writer took this version; retrying");
          continue;
        }
        throw err;
      }
    }
    throw new CasExhaustedError(cfg.domain, key, MAX_CAS_ATTEMPTS);
  }

  async function promote(key: string, version: number, opts: { label?: string; by?: string; gate?: Gate<T>; refs?: Record<string, unknown> } = {}): Promise<void> {
    const existing = await getVersion(key, version);
    if (!existing) throw new VersionNotFoundError(cfg.domain, key, version);
    const label = opts.label ?? DEFAULT_LABEL;
    if (opts.gate) {
      const result = await opts.gate(existing.value);
      emitStoreEvent({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "gate-outcome", domain: cfg.domain, key, version, passed: result.passed, failures: result.failures, refs: opts.refs });
      if (!result.passed) {
        emitStoreEvent({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "promote-refused", domain: cfg.domain, key, version, label, failures: result.failures, refs: opts.refs });
        throw new GateRejectedError(cfg.domain, key, version, result.failures);
      }
    }
    await backend.upsertLabel({ key, label, version, promotedAtIso: new Date().toISOString(), promotedBy: opts.by ?? "admin" });
    emitStoreEvent({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "promote-accepted", domain: cfg.domain, key, version, label, by: opts.by ?? "admin", refs: opts.refs });
    log.info({ key, version, label, by: opts.by ?? "admin" }, "promoted");
  }

  async function listVersions(key: string): Promise<VersionInfo[]> {
    const ptr = await backend.getLabel(key, DEFAULT_LABEL);
    const activeVersion = ptr?.version;
    const docs = await backend.listVersionsDesc(key);
    return docs.map((d) => ({
      version: d.version,
      sha256: d.sha256,
      createdAtIso: d.createdAtIso,
      createdBy: d.createdBy,
      note: d.note,
      active: d.version === activeVersion,
    }));
  }

  async function listKeys(): Promise<KeySummary[]> {
    const keys = await backend.distinctKeys(); // ascending-sorted by the contract
    const out: KeySummary[] = [];
    for (const key of keys) {
      const ptr = await backend.getLabel(key, DEFAULT_LABEL);
      const versions = (await backend.listVersionsDesc(key)).length;
      out.push({ key, activeVersion: ptr?.version ?? null, versions });
    }
    return out;
  }

  async function ensureIndexes(): Promise<void> {
    await backend.init();
  }

  async function seedDefaults(): Promise<Array<{ key: string; seeded: boolean }>> {
    await ensureIndexes();
    const out: Array<{ key: string; seeded: boolean }> = [];
    for (const [key, value] of Object.entries(cfg.defaults)) {
      const exists = (await backend.maxVersion(key)) !== null;
      if (exists) {
        out.push({ key, seeded: false });
        continue;
      }
      const v = await addVersion(key, value, { by: "seed", note: "seeded from code default" });
      await promote(key, v, { by: "seed" });
      out.push({ key, seeded: true });
    }
    return out;
  }

  async function syncDefaults(): Promise<Array<{ key: string; action: "seeded" | "updated" | "unchanged" }>> {
    await ensureIndexes();
    const out: Array<{ key: string; action: "seeded" | "updated" | "unchanged" }> = [];
    for (const [key, value] of Object.entries(cfg.defaults)) {
      const wantSha = cfg.hash(validate(value));
      const active = await getActiveVersion(key);
      if (!active) {
        const v = await addVersion(key, value, { by: "sync", note: "seeded from code default" });
        await promote(key, v, { by: "sync" });
        out.push({ key, action: "seeded" });
      } else if (active.sha256 !== wantSha) {
        const v = await addVersion(key, value, { by: "sync", note: "synced from changed code default" });
        await promote(key, v, { by: "sync" });
        out.push({ key, action: "updated" });
      } else {
        out.push({ key, action: "unchanged" });
      }
    }
    return out;
  }

  return { resolve, getVersion, getActiveVersion, addVersion, promote, listVersions, listKeys, ensureIndexes, seedDefaults, syncDefaults, codeDefault };
}
