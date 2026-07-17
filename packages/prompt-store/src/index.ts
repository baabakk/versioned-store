// @versioned-store/prompt-store — a batteries-included prompt store on top of @versioned-store/core. The
// generic core owns resolve / label / fallback / cache / addVersion / promote / seed; only the PROMPT-specific
// mechanics live here: the payload shape ({ text, config? }), strict placeholder rendering, the Zod var-schema
// validation, unknown-placeholder detection, and the deterministic promote-gate that renders each candidate
// over the key's golden inputs so a broken prompt sits inactive and never goes live. Bring your own backend
// (from @versioned-store/core/backends/*), prompts (defaults), goldens, and var schemas.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createVersionedStore,
  recordFallback,
  VersionedStoreError,
  type KeySummary,
  type VersionedStore,
  type VersionedStoreBackend,
  type VersionInfo,
} from "@versioned-store/core";

// Errors extend the core's base so a consumer's blanket `catch (e instanceof VersionedStoreError)` covers
// the whole library, domain packages included.

/** A prompt could not be rendered: vars failed their schema, or a placeholder was left unbound. */
export class PromptRenderError extends VersionedStoreError {
  constructor(
    message: string,
    public readonly key: string,
  ) {
    super(message);
    this.name = "PromptRenderError";
  }
}

/** A prompt key resolved to nothing: no stored version and no code default to fall back to. */
export class PromptNotFoundError extends VersionedStoreError {
  constructor(
    message: string,
    public readonly key: string,
  ) {
    super(message);
    this.name = "PromptNotFoundError";
  }
}

/** The stored prompt payload: the template text plus optional bundled config. */
export interface PromptPayload {
  text: string;
  config?: Record<string, unknown>;
}

/** A pinned prompt: an immutable version's text plus its identity, safe to thread through a run. */
export interface ResolvedPrompt {
  key: string;
  version: number;
  sha256: string;
  text: string;
  config?: Record<string, unknown>;
}

export interface PromptEvalResult {
  passed: boolean;
  goldenCount: number;
  failures: string[];
}

export type PromptVarSchemas = Record<string, z.ZodType>;
export type PromptGoldens = Record<string, Array<Record<string, unknown>>>;

export interface PromptStoreOptions {
  /** The storage backend (from @versioned-store/core/backends/*). */
  backend: VersionedStoreBackend;
  /** Code-default prompts, served as the sentinel v0 when a key is unseeded or the backend is unavailable. */
  defaults?: Record<string, PromptPayload>;
  /** Per-key Zod var schema: validated at render, and used to detect unknown placeholders at promote. */
  varSchemas?: PromptVarSchemas;
  /** Per-key golden input sets the deterministic promote-gate renders the candidate over. */
  goldens?: PromptGoldens;
  /** Availability probe (e.g. `isMongoConfigured`); when it returns false, resolve serves the code default quietly. */
  backendAvailable?: () => boolean;
  /** Content hash of the template text (default sha256 of the text). */
  hash?: (text: string) => string;
  defaultLabel?: string;
}

export interface PromptStore {
  resolvePin(key: string, label?: string): Promise<ResolvedPrompt>;
  renderPinned(pin: ResolvedPrompt, vars?: Record<string, unknown>): string;
  renderPrompt(key: string, vars?: Record<string, unknown>, label?: string): Promise<string>;
  knownPlaceholders(key: string): string[];
  unknownPlaceholders(key: string, text: string): string[];
  evalPromptVersion(key: string, text: string, version?: number): PromptEvalResult;
  addPromptVersion(key: string, text: string, opts?: { config?: Record<string, unknown>; by?: string; note?: string }): Promise<number>;
  promote(key: string, version: number, opts?: { label?: string; by?: string }): Promise<void>;
  listVersions(key: string): Promise<VersionInfo[]>;
  listKeys(): Promise<KeySummary[]>;
  getPromptText(key: string, version?: number): Promise<{ version: number; text: string } | null>;
  ensureIndexes(): Promise<void>;
  seedDefaults(): Promise<Array<{ key: string; seeded: boolean }>>;
  /** The underlying generic store, if you need core verbs directly. */
  core: VersionedStore<PromptPayload>;
}

function defaultSha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createPromptStore(opts: PromptStoreOptions): PromptStore {
  const hash = opts.hash ?? defaultSha256;
  const varSchemas = opts.varSchemas ?? {};
  const goldens = opts.goldens ?? {};
  const DEFAULT_LABEL = opts.defaultLabel ?? "active";

  const core = createVersionedStore<PromptPayload>(
    {
      domain: "prompt",
      defaultLabel: opts.defaultLabel,
      backendAvailable: opts.backendAvailable,
      defaults: opts.defaults ?? {},
      hash: (v) => hash(v.text),
      toDoc: (v) => ({ text: v.text, config: v.config }),
      fromDoc: (d) => (typeof d.text === "string" ? { text: d.text, config: d.config as Record<string, unknown> | undefined } : null),
    },
    opts.backend,
  );

  function knownPlaceholders(key: string): string[] {
    const schema = varSchemas[key];
    return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
  }

  function unknownPlaceholders(key: string, text: string): string[] {
    const schema = varSchemas[key];
    if (!(schema instanceof z.ZodObject)) return [];
    const known = new Set(Object.keys(schema.shape));
    const found = new Set([...text.matchAll(/\{\{(\w[\w.-]*)\}\}/g)].map((m) => m[1]));
    return [...found].filter((p) => !known.has(p));
  }

  function renderPinned(pin: ResolvedPrompt, vars: Record<string, unknown> = {}): string {
    const schema = varSchemas[pin.key];
    if (schema) {
      const parsed = schema.safeParse(vars);
      if (!parsed.success) {
        const where = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        throw new PromptRenderError(`[prompt-store] invalid vars for "${pin.key}" v${pin.version}: ${where}`, pin.key);
      }
    }
    let out = pin.text;
    for (const [k, v] of Object.entries(vars)) {
      // Neutralize any {{ }} embedded in a (possibly model-generated) value so it cannot be mistaken for a
      // template placeholder or corrupt the leftover-placeholder check.
      const safe = String(v).replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
      out = out.split(`{{${k}}}`).join(safe);
    }
    const leftover = /\{\{(\w[\w.-]*)\}\}/.exec(out);
    if (leftover) {
      recordFallback("prompt", pin.key, "unbound-placeholder", { extra: { placeholder: leftover[1], version: pin.version } });
      throw new PromptRenderError(`[prompt-store] unbound placeholder {{${leftover[1]}}} in "${pin.key}" v${pin.version}`, pin.key);
    }
    return out;
  }

  function evalPromptVersion(key: string, text: string, version = 0): PromptEvalResult {
    const g = goldens[key] ?? [{}];
    const pin: ResolvedPrompt = { key, version, sha256: hash(text), text };
    const failures: string[] = [];
    for (let i = 0; i < g.length; i++) {
      try {
        renderPinned(pin, g[i]);
      } catch (err) {
        failures.push(`golden[${i}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { passed: failures.length === 0, goldenCount: g.length, failures };
  }

  async function resolvePin(key: string, label = DEFAULT_LABEL): Promise<ResolvedPrompt> {
    const r = await core.resolve(key, label);
    if (!r) throw new PromptNotFoundError(`[prompt-store] no code default for key "${key}"`, key);
    return { key: r.key, version: r.version, sha256: r.sha256, text: r.value.text, config: r.value.config };
  }

  return {
    core,
    resolvePin,
    renderPinned,
    renderPrompt: async (key, vars = {}, label = DEFAULT_LABEL) => renderPinned(await resolvePin(key, label), vars),
    knownPlaceholders,
    unknownPlaceholders,
    evalPromptVersion,
    addPromptVersion: (key, text, o = {}) => core.addVersion(key, { text, config: o.config }, { by: o.by, note: o.note }),
    // Gated promote: refuse an unknown placeholder OR a golden-render eval failure, so a broken edit sits inactive.
    promote: (key, version, o = {}) =>
      core.promote(key, version, {
        label: o.label,
        by: o.by,
        gate: (value) => {
          const failures: string[] = [];
          const unknown = unknownPlaceholders(key, value.text);
          if (unknown.length) {
            const valid = knownPlaceholders(key).map((p) => `{{${p}}}`).join(", ") || "(none)";
            failures.push(`unknown placeholder(s) ${unknown.map((p) => `{{${p}}}`).join(", ")} would fail at render (valid for this key: ${valid})`);
          }
          const evalResult = evalPromptVersion(key, value.text, version);
          if (!evalResult.passed) failures.push(`eval gate failed over ${evalResult.goldenCount} golden input(s): ${evalResult.failures.join("; ")}`);
          return { passed: failures.length === 0, failures };
        },
      }),
    listVersions: (key) => core.listVersions(key),
    listKeys: () => core.listKeys(),
    getPromptText: async (key, version) => {
      const r = version == null ? await core.getActiveVersion(key) : await core.getVersion(key, version);
      return r ? { version: r.version, text: r.value.text } : null;
    },
    ensureIndexes: () => core.ensureIndexes(),
    seedDefaults: () => core.seedDefaults(),
  };
}
