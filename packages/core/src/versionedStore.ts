import { emitStoreEvent, STORE_EVENT_SCHEMA_VERSION, type StoreEvent, type FallbackReason } from "./events.js";
import { BackendConflictError, type StoredDoc, type VersionedStoreBackend } from "./backend.js";
import { storeLog } from "./logger.js";
import { CasExhaustedError, GateRejectedError, KillSwitchNotSupportedError, VersionedStoreError, VersionNotFoundError } from "./errors.js";

/** Max optimistic-CAS retries on the version bump before giving up (a hot-loop bound, never hit in practice). */
const MAX_CAS_ATTEMPTS = 5;

/** Doc keys the store owns (metadata). Everything else in a StoredDoc is a domain field from `toDoc`. */
const RESERVED_DOC_KEYS = new Set(["key", "version", "sha256", "createdAtIso", "createdBy", "note"]);

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

/**
 * A per-key gate for `checkDefaults`. Unlike `Gate<T>` (used at promote, where the key is already fixed),
 * this takes the key alongside the value, because a domain's gate is per-key (what makes one key's default
 * valid says nothing about another's). Sync or async, mirroring `Gate<T>`.
 */
export type DefaultsGate<T> = (key: string, value: T) => GateResult | Promise<GateResult>;

/** One key's result in a defaults-health report. */
export interface DefaultCheck {
  key: string;
  passed: boolean;
  failures: string[];
}

/** The report from `checkDefaults`: whether every registered default passed its gate, plus the per-key detail. */
export interface DefaultsHealthReport {
  ok: boolean;
  results: DefaultCheck[];
}

/** One key's outcome from `seedDefaults`. `refused` is set (with `failures`) when a supplied gate rejected the default. */
export interface SeedResult {
  key: string;
  seeded: boolean;
  refused?: boolean;
  failures?: string[];
}

/** One key's outcome from `syncDefaults`. `"refused"` (with `failures`) is set when a supplied gate rejected the default. */
export interface SyncResult {
  key: string;
  action: "seeded" | "updated" | "unchanged" | "refused";
  failures?: string[];
}

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

/**
 * An at-rest cipher for stored payload fields. The store applies it at the storage boundary ONLY: encrypt
 * AFTER `toDoc` on write, decrypt BEFORE `fromDoc` on read. The content hash and the eval-gate stay over the
 * PLAINTEXT value, so dedup and gating are unaffected and a randomized cipher (per-record IV) carries no dedup
 * penalty. `encrypt`/`decrypt` operate on opaque strings; the store JSON-serializes each field value before
 * encrypt and JSON-parses after decrypt, so any JSON payload field can be encrypted.
 *
 * Sync or async (`string | Promise<string>`), so a node:crypto cipher and a KMS cipher both fit. Threat model:
 * this protects the backend AT REST; it does NOT protect a live compromised process (which holds the key and
 * the decrypted resolve cache). It is not a secrets manager: key storage, leasing, and rotation stay the host's.
 */
export interface StoreCipher {
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(ciphertext: string): string | Promise<string>;
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
  /**
   * Optional at-rest cipher for the stored doc fields. Applied AFTER `toDoc` on write and BEFORE `fromDoc` on
   * read; the content hash and the eval-gate stay over the PLAINTEXT value (unchanged), so enabling it does not
   * alter dedup, sync change-detection, or gating. See `StoreCipher`. Versions are immutable, so turning the
   * cipher on protects FUTURE versions only; a version written without it is a cleartext version and will fail
   * to decrypt (fail-closed to the code default). The built-in `createAesGcmCipher` is at `@versioned-store/core/cipher`.
   */
  cipher?: StoreCipher;
  /**
   * Which `toDoc` fields to encrypt. Names must match `toDoc`'s output keys. Default (undefined): every field
   * `toDoc` emits. Name a subset to keep the rest queryable at rest (e.g. encrypt only the secret fields of a
   * config blob). Ignored when `cipher` is not set.
   */
  encryptedFields?: string[];
  /** Optional validation applied before an insert (throws on invalid); used by add + seed + sync. */
  validate?: (value: T) => T;
  /**
   * When true, falling back to the code default is a FIRST-CLASS path (e.g. the Scaffold Store, where a
   * routed-but-unseeded key legitimately uses the in-code spec), so label/doc-missing fallbacks log at
   * debug instead of WARN. Leave false for prompts, where a fallback means a prompt that should be
   * seeded is not (a genuine alarm). Real anomalies (resolve-error, schema-invalid) always WARN.
   */
  codeDefaultIsFirstClass?: boolean;
  /**
   * Optional durable event sink. Called on EVERY store event (fallback, gate-outcome, promote-refused,
   * promote-accepted), alongside the injected logger, so a host can persist an at-source audit trail that
   * captures promotions bypassing any wrapper (the ungated kill-switch, scripts, admin routes). Errors thrown
   * by the sink are swallowed, so a sink failure never disrupts a promote or a resolve.
   */
  onEvent?: (event: StoreEvent) => void;
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
  promote(key: string, version: number, opts?: { label?: string; by?: string; gate?: Gate<T>; refs?: Record<string, unknown>; note?: string }): Promise<void>;
  listVersions(key: string): Promise<VersionInfo[]>;
  listKeys(): Promise<KeySummary[]>;
  ensureIndexes(): Promise<void>;
  /**
   * Idempotent: for each code default not yet in the store, insert it as v1 and set active -> 1. Pass
   * `opts.gate` to VERIFY each default before it is promoted (verify-on-seed): a default the gate rejects is
   * skipped and reported with `refused: true`, never made active. Without a gate, every default is seeded
   * (the pre-existing behavior).
   */
  seedDefaults(opts?: { gate?: DefaultsGate<T> }): Promise<SeedResult[]>;
  /**
   * For each code default whose content differs from the active version (or is unseeded), add + promote. Pass
   * `opts.gate` to refuse an unsound default (reported as `action: "refused"`) instead of promoting it.
   */
  syncDefaults(opts?: { gate?: DefaultsGate<T> }): Promise<SyncResult[]>;
  /** The in-code default as a Resolved (sentinel version 0), or null when the key has no default. */
  codeDefault(key: string): Resolved<T> | null;
  /**
   * Return a key to its in-code default: add the default as a new immutable version and promote it, UNGATED
   * (a kill-switch a gate can block is not a kill-switch; the default is boot-proven safe). Returns the new
   * version. Throws when the key has no in-code default. This is the supported single-key kill-switch; prefer
   * it over `syncDefaults()` (reverts every key) and over `promote(key, 0)` (0 is the sentinel, not stored).
   */
  revertToCodeDefault(key: string, opts?: { by?: string; note?: string; label?: string }): Promise<number>;
  /**
   * Run `gate` over every registered code default and return a report. Pure: reads only the in-code defaults,
   * touches no backend, emits no event, never throws. This verifies the FALLBACK-SOUNDNESS assumption the
   * store leans on: a code default is served on every `resolve` fallback AND is the value `revertToCodeDefault`
   * re-promotes, so it must be able to pass the same gate a candidate version must. The POLICY on an unhealthy
   * default (throw at boot, warn, degrade) is the CALLER's; inspect `report.ok`. Complements `codeDefault(key)`
   * (one value) by verifying they are all gate-valid.
   */
  checkDefaults(gate: DefaultsGate<T>): Promise<DefaultsHealthReport>;
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

  // Fan every store event out to the injected logger (emitStoreEvent) AND, when configured, the durable sink
  // (cfg.onEvent). Sink errors are swallowed: a failing sink must never break a promote or a resolve.
  function emit(event: StoreEvent, opts?: { alarm?: boolean }): void {
    emitStoreEvent(event, opts);
    if (cfg.onEvent) {
      try {
        cfg.onEvent(event);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "onEvent sink threw (swallowed)");
      }
    }
  }

  function emitFallback(key: string, reason: FallbackReason, opts: { alarm?: boolean; extra?: Record<string, unknown> } = {}): void {
    emit({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "fallback", domain: cfg.domain, key, reason, extra: opts.extra }, { alarm: opts.alarm });
  }

  function validate(value: T): T {
    return cfg.validate ? cfg.validate(value) : value;
  }

  // Encrypt the configured (or all) domain fields of a toDoc output, in place on a copy. Each field value is
  // JSON-serialized before encrypt so any JSON payload works; a listed field toDoc did not emit is skipped
  // (there is nothing to encrypt). Called once per addVersion (the plaintext hash is computed separately).
  async function encryptDomainFields(domainFields: Record<string, unknown>, cipher: StoreCipher): Promise<Record<string, unknown>> {
    const names = cfg.encryptedFields ?? Object.keys(domainFields);
    const out: Record<string, unknown> = { ...domainFields };
    for (const name of names) {
      // Nothing to encrypt when the field is absent or explicitly undefined (e.g. an omitted optional field);
      // JSON.stringify(undefined) is undefined, not a string, so this also keeps the cipher from choking on it.
      if (out[name] === undefined) continue;
      out[name] = await cipher.encrypt(JSON.stringify(out[name]));
    }
    return out;
  }

  // Decrypt the configured (or all non-metadata) fields of a stored doc, returning a doc `fromDoc` can read, or
  // null when a field cannot be recovered. A field written WITHOUT the cipher (a cleartext/pre-encryption
  // version) is a non-string here, or fails auth on decrypt; either way we fail CLOSED (null -> the caller
  // serves the code default) rather than hand `fromDoc` a value we cannot vouch for. Enabling the cipher
  // protects future versions only, by design (versions are immutable).
  async function decryptDocFields(doc: StoredDoc, cipher: StoreCipher): Promise<Record<string, unknown> | null> {
    const names = cfg.encryptedFields ?? Object.keys(doc).filter((k) => !RESERVED_DOC_KEYS.has(k));
    const out: Record<string, unknown> = { ...doc };
    for (const name of names) {
      const raw = out[name];
      if (raw === undefined) continue;
      if (typeof raw !== "string") {
        log.warn({ key: doc.key, version: doc.version, field: name }, "encrypted field is not a ciphertext string (a pre-cipher version?); serving fallback");
        return null;
      }
      try {
        out[name] = JSON.parse(await cipher.decrypt(raw));
      } catch (err) {
        log.warn({ key: doc.key, version: doc.version, field: name, err: err instanceof Error ? err.message : String(err) }, "decrypt failed; serving fallback");
        return null;
      }
    }
    return out;
  }

  async function docToResolved(key: string, doc: StoredDoc): Promise<Resolved<T> | null> {
    let source: Record<string, unknown> = doc;
    if (cfg.cipher) {
      const decrypted = await decryptDocFields(doc, cfg.cipher);
      if (!decrypted) return null;
      source = decrypted;
    }
    const value = cfg.fromDoc(source);
    if (value === null) return null;
    return { key, version: doc.version, sha256: doc.sha256 ?? cfg.hash(value), value };
  }

  async function resolve(key: string, label = DEFAULT_LABEL): Promise<Resolved<T> | null> {
    if (cfg.backendAvailable && !cfg.backendAvailable()) {
      emitFallback(key, "backend-unavailable");
      return codeDefault(key);
    }
    try {
      const ptr = await backend.getLabel(key, label);
      if (!ptr || typeof ptr.version !== "number") {
        emitFallback(key, "label-missing", { alarm: !cfg.codeDefaultIsFirstClass, extra: { label } });
        return codeDefault(key);
      }
      const cacheKey = `${key}:v${ptr.version}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const doc = await backend.getVersion(key, ptr.version);
      if (!doc) {
        emitFallback(key, "doc-missing", { alarm: !cfg.codeDefaultIsFirstClass, extra: { version: ptr.version } });
        return codeDefault(key);
      }
      const resolved = await docToResolved(key, doc);
      if (!resolved) {
        // A stored value failing validation is a real anomaly, so it always alarms (even for scaffolds).
        emitFallback(key, "schema-invalid", { extra: { version: ptr.version } });
        return codeDefault(key);
      }
      cache.set(cacheKey, resolved);
      return resolved;
    } catch (err) {
      emitFallback(key, "resolve-error", { extra: { label, err: err instanceof Error ? err.message : String(err) } });
      return codeDefault(key);
    }
  }

  async function getVersion(key: string, version: number): Promise<Resolved<T> | null> {
    const doc = await backend.getVersion(key, version);
    return doc ? await docToResolved(key, doc) : null;
  }

  async function getActiveVersion(key: string, label = DEFAULT_LABEL): Promise<Resolved<T> | null> {
    const ptr = await backend.getLabel(key, label);
    if (!ptr || typeof ptr.version !== "number") return null;
    return getVersion(key, ptr.version);
  }

  async function addVersion(key: string, value: T, opts: { by?: string; note?: string } = {}): Promise<number> {
    const v = validate(value);
    // Map + (optionally) encrypt the domain fields ONCE, before the CAS loop: they do not depend on the version
    // number, and re-encrypting per retry would only burn a fresh IV for nothing. The plaintext hash below is
    // computed from `v`, not from these fields, so encryption never changes the version identity.
    const storedFields = cfg.cipher ? await encryptDomainFields(cfg.toDoc(v), cfg.cipher) : cfg.toDoc(v);
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
        ...storedFields,
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

  async function promote(key: string, version: number, opts: { label?: string; by?: string; gate?: Gate<T>; refs?: Record<string, unknown>; note?: string } = {}): Promise<void> {
    if (version === 0) throw new KillSwitchNotSupportedError(cfg.domain, key);
    const existing = await getVersion(key, version);
    if (!existing) throw new VersionNotFoundError(cfg.domain, key, version);
    const label = opts.label ?? DEFAULT_LABEL;
    if (opts.gate) {
      const result = await opts.gate(existing.value);
      emit({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "gate-outcome", domain: cfg.domain, key, version, passed: result.passed, failures: result.failures, refs: opts.refs });
      if (!result.passed) {
        emit({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "promote-refused", domain: cfg.domain, key, version, label, failures: result.failures, refs: opts.refs });
        throw new GateRejectedError(cfg.domain, key, version, result.failures);
      }
    }
    await backend.upsertLabel({ key, label, version, promotedAtIso: new Date().toISOString(), promotedBy: opts.by ?? "admin", note: opts.note, refs: opts.refs });
    emit({ schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "promote-accepted", domain: cfg.domain, key, version, label, by: opts.by ?? "admin", note: opts.note, refs: opts.refs });
    log.info({ key, version, label, by: opts.by ?? "admin" }, "promoted");
  }

  async function revertToCodeDefault(key: string, opts: { by?: string; note?: string; label?: string } = {}): Promise<number> {
    const cd = codeDefault(key);
    if (!cd) throw new VersionedStoreError(`[store:${cfg.domain}] cannot revert ${key} to the in-code default: no default is registered for this key`);
    const by = opts.by ?? "revert";
    const note = opts.note ?? "reverted to in-code default";
    const v = await addVersion(key, cd.value, { by, note });
    // Ungated by design: a kill-switch a gate can block is not a kill-switch, and the default is boot-proven safe.
    await promote(key, v, { by, note, label: opts.label });
    return v;
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

  async function seedDefaults(opts: { gate?: DefaultsGate<T> } = {}): Promise<SeedResult[]> {
    await ensureIndexes();
    const out: SeedResult[] = [];
    for (const [key, value] of Object.entries(cfg.defaults)) {
      const exists = (await backend.maxVersion(key)) !== null;
      if (exists) {
        out.push({ key, seeded: false });
        continue;
      }
      // verify-on-seed: seed promotes the code default to the ACTIVE version, so an unsound default (one that
      // cannot pass its own gate) would be made active unvalidated. When a gate is supplied, refuse it instead:
      // skip the promote and report it. The key stays unseeded and its (still-unsound) default is served only
      // via the fallback path, which the caller guards at boot with `checkDefaults`. The caller decides whether
      // a refused default is fatal; seed never throws on one, so a single bad default cannot halt the seed.
      if (opts.gate) {
        const r = await opts.gate(key, value);
        if (!r.passed) {
          log.warn({ key, failures: r.failures }, "seedDefaults refused an unsound code default (not promoted to active)");
          out.push({ key, seeded: false, refused: true, failures: r.failures });
          continue;
        }
      }
      const v = await addVersion(key, value, { by: "seed", note: "seeded from code default" });
      await promote(key, v, { by: "seed" });
      out.push({ key, seeded: true });
    }
    return out;
  }

  async function syncDefaults(opts: { gate?: DefaultsGate<T> } = {}): Promise<SyncResult[]> {
    await ensureIndexes();
    const out: SyncResult[] = [];
    for (const [key, value] of Object.entries(cfg.defaults)) {
      const wantSha = cfg.hash(validate(value));
      const active = await getActiveVersion(key);
      if (active && active.sha256 === wantSha) {
        out.push({ key, action: "unchanged" });
        continue;
      }
      // Sync would add + promote the default (either seed a missing key or update a drifted one). Same
      // verify-on-seed rule as above: refuse an unsound default rather than promote it to active.
      if (opts.gate) {
        const r = await opts.gate(key, value);
        if (!r.passed) {
          log.warn({ key, failures: r.failures }, "syncDefaults refused an unsound code default (not promoted to active)");
          out.push({ key, action: "refused", failures: r.failures });
          continue;
        }
      }
      if (!active) {
        const v = await addVersion(key, value, { by: "sync", note: "seeded from code default" });
        await promote(key, v, { by: "sync" });
        out.push({ key, action: "seeded" });
      } else {
        const v = await addVersion(key, value, { by: "sync", note: "synced from changed code default" });
        await promote(key, v, { by: "sync" });
        out.push({ key, action: "updated" });
      }
    }
    return out;
  }

  async function checkDefaults(gate: DefaultsGate<T>): Promise<DefaultsHealthReport> {
    const results: DefaultCheck[] = [];
    for (const [key, value] of Object.entries(cfg.defaults)) {
      const r = await gate(key, value);
      results.push({ key, passed: r.passed, failures: r.failures });
    }
    return { ok: results.every((r) => r.passed), results };
  }

  return { resolve, getVersion, getActiveVersion, addVersion, promote, revertToCodeDefault, listVersions, listKeys, ensureIndexes, seedDefaults, syncDefaults, codeDefault, checkDefaults };
}
