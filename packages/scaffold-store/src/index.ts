// @versioned-store/scaffold-store — a batteries-included scaffold store on top of @versioned-store/core.
// The generic core owns resolve / label / fallback / cache / addVersion / promote / seed; only the SCAFFOLD-
// specific mechanics live here: the payload shape, strict {placeholder} command rendering, key routing, and
// the deterministic promote-gate that refuses an unpinned, unbound, or unknown-executable spec so a broken
// scaffold sits inactive and never runs. Bring your own backend (from @versioned-store/core/backends/*),
// specs (defaults), schema, and router.
//
// A scaffold spec describes how to materialize ONE project skeleton for a given kind of package: run a
// pinned, non-interactive first-party scaffolder ("mode": "command"), or hand-roll it ("mode": "handroll").
// Unlike a prompt, a MISSING scaffold is a normal outcome ("no spec for this key, hand-roll it"), so resolve
// returns null instead of throwing and a code-default fallback is first-class rather than an alarm.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createVersionedStore,
  VersionedStoreError,
  type DefaultsHealthReport,
  type KeySummary,
  type SeedResult,
  type StoreCipher,
  type StoreEvent,
  type SyncResult,
  type VersionedStore,
  type VersionedStoreBackend,
  type VersionInfo,
} from "@versioned-store/core";

// ---------------------------------------------------------------------------
// The spec shape
// ---------------------------------------------------------------------------

/**
 * The minimum spec the store and its gate reason about. Extend it with `.extend({...})` to carry your own
 * domain fields (monorepo patches, buildability, docs) and pass the extended schema as `schema`.
 */
export const BaseScaffoldSpecSchema = z
  .object({
    /** The routing key this spec answers to (e.g. "web.frontend.react-vite"). */
    key: z.string().min(1),
    scaffold: z.object({
      /** "command" runs a pinned external scaffolder; "handroll" means the host materializes it in code. */
      mode: z.enum(["command", "handroll"]),
      /** The scaffolder invocation. May reference {placeholder} vars (default: {dir}). Command mode only. */
      command: z.string().optional(),
      /** "fresh" scaffolds into an empty dir; "overwrite" allows it to land on existing files. */
      placement: z.enum(["fresh", "overwrite"]),
      /** Whether the command reaches the network (a pinned version is then required by the gate). */
      network: z.boolean(),
    }),
    install: z.string().optional(),
    build: z.string().optional(),
    test: z.string().optional(),
  })
  .strict();

export type BaseScaffoldSpec = z.infer<typeof BaseScaffoldSpecSchema>;

/** The shape any spec type must be assignable to for the store and gate to work with it. */
export type ScaffoldSpecLike = BaseScaffoldSpec;

// ---------------------------------------------------------------------------
// Errors (extend the core's base so a blanket `catch (e instanceof VersionedStoreError)` keeps working)
// ---------------------------------------------------------------------------

/** A command could not be rendered: an unbound {placeholder}, or a spec that has no command to render. */
export class ScaffoldRenderError extends VersionedStoreError {
  constructor(
    message: string,
    public readonly key: string,
  ) {
    super(message);
    this.name = "ScaffoldRenderError";
  }
}

/** `resolveFor` was called on a store constructed without a `keyFor` router. */
export class ScaffoldRouteError extends VersionedStoreError {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldRouteError";
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Executables a scaffold command may invoke. The default set is the mainstream package managers and
 * runtimes; a host with a narrower threat model should pass its own, shorter list.
 */
export const DEFAULT_ALLOWED_EXECUTABLES = [
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx",
  "node", "deno", "git", "cargo", "dotnet", "go",
  "python", "python3", "uv", "uvx", "composer", "gradle", "mvn",
];

/**
 * Version tags that float. A scaffold pinned to one of these produces a different skeleton tomorrow than it
 * did today, which defeats the point of versioning the spec at all: the spec is immutable but what it runs
 * is not. The gate refuses them on any networked command.
 */
const FLOATING_TAGS = ["latest", "next", "canary", "beta", "rc", "dev", "nightly", "alpha"];

export interface ScaffoldGateOptions {
  /** Executables a command may invoke (checked against the first token). Default: DEFAULT_ALLOWED_EXECUTABLES. */
  allowedExecutables?: string[];
  /** Placeholder names a command may reference. Default: ["dir"]. */
  allowedVars?: string[];
  /** Refuse floating version tags in a networked command. Default: true. */
  requirePinnedCommand?: boolean;
}

export interface ScaffoldEvalResult {
  passed: boolean;
  failures: string[];
}

/** Every `{placeholder}` referenced by a template, in order of appearance, de-duplicated. */
export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w[\w.-]*)\}/g)].map((m) => m[1]))];
}

/**
 * Substitute `{name}` placeholders. Throws on any placeholder left unbound, so a half-rendered command can
 * never reach a shell: an unbound {dir} would otherwise scaffold into a literal directory called "{dir}".
 */
export function renderTemplate(template: string, vars: Record<string, string | number> = {}, key = "(spec)"): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  const leftover = placeholdersIn(out);
  if (leftover.length > 0) {
    throw new ScaffoldRenderError(
      `[scaffold-store] unbound placeholder(s) ${leftover.map((p) => `{${p}}`).join(", ")} in "${key}"`,
      key,
    );
  }
  return out;
}

/** The first token of a command line, which is the executable it invokes. */
function executableOf(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * The deterministic promote-gate, fully offline. It is the scaffold analogue of the prompt store's golden
 * render: it proves the spec is runnable and reproducible BEFORE the label flips, so a broken or floating
 * scaffold sits inactive rather than materializing a wrong skeleton for every consumer downstream.
 */
export function evalScaffoldSpec<T extends ScaffoldSpecLike>(
  key: string,
  spec: unknown,
  schema: z.ZodType<T>,
  opts: ScaffoldGateOptions = {},
): ScaffoldEvalResult {
  const allowedExecutables = opts.allowedExecutables ?? DEFAULT_ALLOWED_EXECUTABLES;
  const allowedVars = opts.allowedVars ?? ["dir"];
  const requirePinned = opts.requirePinnedCommand ?? true;
  const failures: string[] = [];

  const parsed = schema.safeParse(spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      failures.push(`schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    // Every check below reads parsed fields, so without a valid spec there is nothing further to say.
    return { passed: false, failures };
  }
  const value = parsed.data;

  if (value.key !== key) {
    failures.push(`spec.key is "${value.key}" but it is stored under "${key}"; a rename would silently misroute`);
  }

  const { mode, command, network } = value.scaffold;
  if (mode === "command" && !command) {
    failures.push(`scaffold.mode is "command" but no scaffold.command is set`);
  }
  if (mode === "handroll" && command) {
    failures.push(`scaffold.mode is "handroll" but a scaffold.command is set; it would never run`);
  }

  const commands: Array<[string, string]> = [];
  if (command) commands.push(["scaffold.command", command]);
  for (const field of ["install", "build", "test"] as const) {
    const c = value[field];
    if (c) commands.push([field, c]);
  }

  // Placeholder binding applies to every command: an unbound {dir} is a bug wherever it appears.
  for (const [field, c] of commands) {
    const unknown = placeholdersIn(c).filter((p) => !allowedVars.includes(p));
    if (unknown.length > 0) {
      failures.push(
        `${field}: unknown placeholder(s) ${unknown.map((p) => `{${p}}`).join(", ")} would be unbound at render ` +
          `(allowed: ${allowedVars.map((v) => `{${v}}`).join(", ") || "(none)"})`,
      );
    }
  }

  // The executable allowlist applies ONLY to scaffold.command. That command is the supply-chain surface: it
  // runs BEFORE the project exists, usually fetching a foreign scaffolder over the network, so what it may
  // invoke is worth constraining. install/build/test run afterwards INSIDE the materialized project against
  // its own devDependencies ("tsc -b", "vite build", "jest"), and allowlisting those would mean enumerating
  // every build tool that exists. Their reproducibility is the project's lockfile problem, not this gate's.
  if (command) {
    const exe = executableOf(command);
    if (exe && !allowedExecutables.includes(exe)) {
      failures.push(`scaffold.command: executable "${exe}" is not allowed (allowed: ${allowedExecutables.join(", ")})`);
    }
  }

  if (requirePinned && mode === "command" && network && command) {
    const floating = FLOATING_TAGS.filter((t) => new RegExp(`@${t}(?![\\w.-])`).test(command));
    if (floating.length > 0) {
      failures.push(
        `scaffold.command uses the floating tag(s) ${floating.map((t) => `@${t}`).join(", ")}; a networked ` +
          `scaffold must pin an exact version or it produces a different skeleton on every run`,
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface ScaffoldStoreOptions<T extends ScaffoldSpecLike, R = unknown> {
  /** The storage backend (from @versioned-store/core/backends/*). */
  backend: VersionedStoreBackend;
  /** Code-default specs, served as the sentinel v0 when a key is unseeded or the backend is unavailable. */
  defaults?: Record<string, T>;
  /** Zod schema for the full spec. Default: BaseScaffoldSpecSchema. Extend the base to add domain fields. */
  schema?: z.ZodType<T>;
  /**
   * Route a structured input (e.g. a subsystem descriptor) to a scaffold key. Domain-specific, so it is
   * injected rather than guessed: return null for "nothing indicates a scaffolder, hand-roll it".
   */
  keyFor?: (input: R) => string | null;
  /** Availability probe; when it returns false, resolve serves the code default quietly. */
  backendAvailable?: () => boolean;
  /**
   * Optional durable event sink, threaded through to the core. Called on every store event (fallback,
   * gate-outcome, promote-refused, promote-accepted) alongside the injected logger, so a host can persist an
   * at-source audit trail of scaffold promotions. Sink errors are swallowed, so a failing sink never disrupts
   * a promote or a resolve.
   */
  onEvent?: (event: StoreEvent) => void;
  /**
   * Optional at-rest cipher for the stored spec, applied AFTER toDoc and BEFORE fromDoc. The content hash and
   * the promote-gate stay over the plaintext spec, so promotion behavior is unchanged. The built-in AES-256-GCM
   * cipher is at `@versioned-store/core/cipher`. Scaffold payloads nest under a single `spec` field, so
   * `encryptedFields` is `["spec"]` or omitted (the default encrypts it).
   */
  cipher?: StoreCipher;
  /** Which stored fields to encrypt when `cipher` is set. Default (undefined): every field, i.e. `spec`. */
  encryptedFields?: string[];
  /** Content hash of a spec (default: sha256 of its stable JSON). */
  hash?: (spec: T) => string;
  defaultLabel?: string;
  /** Tunes the deterministic promote-gate (allowed executables, allowed vars, pinning). */
  gate?: ScaffoldGateOptions;
}

export interface ScaffoldStore<T extends ScaffoldSpecLike, R = unknown> {
  /** Resolve the active spec for a key. Null means "no spec, hand-roll it", NOT an error. */
  resolveScaffold(key: string, label?: string): Promise<T | null>;
  /** Route an input to its key, then resolve. Null when the router declines or the key has no spec. */
  resolveFor(input: R, label?: string): Promise<T | null>;
  /** The key this input routes to, or null. Exposed so a caller can log/branch without resolving. */
  keyFor(input: R): string | null;
  /** Render `scaffold.command` with strict {placeholder} binding. Throws on an unbound placeholder. */
  renderCommand(spec: T, vars?: Record<string, string | number>): string;
  /** Run the deterministic gate against a candidate spec without promoting it. */
  evalScaffoldVersion(key: string, spec: unknown): ScaffoldEvalResult;
  addScaffoldVersion(key: string, spec: T, opts?: { by?: string; note?: string }): Promise<number>;
  /** Gated: a spec that fails the deterministic gate is refused at the label flip. */
  promote(key: string, version: number, opts?: { label?: string; by?: string; note?: string; refs?: Record<string, unknown> }): Promise<void>;
  /**
   * Return a key to its in-code default: adds the default spec as a new version and promotes it, UNGATED
   * (a kill-switch a gate can block is not a kill-switch). Returns the new version. The supported single-key
   * kill-switch; prefer it over `syncDefaults` or `promote(key, 0)`.
   */
  revertToCodeDefault(key: string, opts?: { by?: string; note?: string; label?: string }): Promise<number>;
  listVersions(key: string): Promise<VersionInfo[]>;
  listKeys(): Promise<KeySummary[]>;
  ensureIndexes(): Promise<void>;
  /** Seed each unseeded code-default spec as its first version. Verify-on-seed is ALWAYS on: a default that fails the promote-gate (pinning + binding + allowlist) is refused (`refused: true`), not made active. */
  seedDefaults(): Promise<SeedResult[]>;
  /** Add + promote each drifted or unseeded code-default spec. Verify-on-seed is ALWAYS on: an unsound default is reported `action: "refused"` instead of promoted. */
  syncDefaults(): Promise<SyncResult[]>;
  /**
   * Run every code-default spec through the SAME deterministic gate `promote` uses (pinning + placeholder
   * binding + executable allowlist + mode/key coherence) and return a report: whether each default could
   * itself go live. The policy on a failure (throw at boot, warn) is the caller's.
   */
  checkDefaults(): Promise<DefaultsHealthReport>;
  /** The underlying generic store, if you need core verbs directly. */
  core: VersionedStore<T>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function defaultHash(spec: unknown): string {
  // Key order must not change the hash: the hash is version identity and drives syncDefaults change
  // detection, so a re-ordered but identical spec must not look like an edit.
  return createHash("sha256").update(stableJson(spec)).digest("hex");
}

export function createScaffoldStore<T extends ScaffoldSpecLike, R = unknown>(
  opts: ScaffoldStoreOptions<T, R>,
): ScaffoldStore<T, R> {
  const schema = opts.schema ?? (BaseScaffoldSpecSchema as unknown as z.ZodType<T>);
  const hash = opts.hash ?? defaultHash;
  const gateOpts = opts.gate ?? {};
  const DEFAULT_LABEL = opts.defaultLabel ?? "active";

  const core = createVersionedStore<T>(
    {
      domain: "scaffold",
      defaultLabel: opts.defaultLabel,
      backendAvailable: opts.backendAvailable,
      onEvent: opts.onEvent,
      cipher: opts.cipher,
      encryptedFields: opts.encryptedFields,
      defaults: opts.defaults ?? {},
      hash,
      // The on-disk shape nests the spec under `spec`, matching the hand-written store this generalizes.
      toDoc: (s) => ({ spec: s }),
      fromDoc: (d) => {
        const parsed = schema.safeParse(d.spec);
        return parsed.success ? parsed.data : null;
      },
      validate: (s) => schema.parse(s),
      // A routed-but-unseeded key legitimately uses the in-code spec, so a fallback here is normal operation
      // and must not WARN on every unseeded key. Prompts leave this false, where a fallback IS the alarm.
      codeDefaultIsFirstClass: true,
    },
    opts.backend,
  );

  function keyFor(input: R): string | null {
    if (!opts.keyFor) {
      throw new ScaffoldRouteError(
        `[scaffold-store] no keyFor router was configured; pass one to createScaffoldStore or call resolveScaffold(key) directly`,
      );
    }
    return opts.keyFor(input);
  }

  function renderCommand(spec: T, vars: Record<string, string | number> = {}): string {
    const command = spec.scaffold.command;
    if (!command) {
      throw new ScaffoldRenderError(
        `[scaffold-store] "${spec.key}" has scaffold.mode "${spec.scaffold.mode}" and no command to render`,
        spec.key,
      );
    }
    return renderTemplate(command, vars, spec.key);
  }

  return {
    core,
    keyFor,
    resolveScaffold: async (key, label = DEFAULT_LABEL) => {
      const r = await core.resolve(key, label);
      return r ? r.value : null;
    },
    resolveFor: async (input, label = DEFAULT_LABEL) => {
      const key = keyFor(input);
      if (!key) return null;
      const r = await core.resolve(key, label);
      return r ? r.value : null;
    },
    renderCommand,
    evalScaffoldVersion: (key, spec) => evalScaffoldSpec(key, spec, schema, gateOpts),
    addScaffoldVersion: (key, spec, o = {}) => core.addVersion(key, spec, o),
    promote: (key, version, o = {}) =>
      core.promote(key, version, {
        label: o.label,
        by: o.by,
        note: o.note,
        refs: o.refs,
        gate: (value) => evalScaffoldSpec(key, value, schema, gateOpts),
      }),
    revertToCodeDefault: (key, o = {}) => core.revertToCodeDefault(key, o),
    listVersions: (key) => core.listVersions(key),
    listKeys: () => core.listKeys(),
    ensureIndexes: () => core.ensureIndexes(),
    // Verify-on-seed: auto-inject the same gate promote uses, so seeding/sync cannot make an unsound spec active.
    seedDefaults: () => core.seedDefaults({ gate: (key, value) => evalScaffoldSpec(key, value, schema, gateOpts) }),
    syncDefaults: () => core.syncDefaults({ gate: (key, value) => evalScaffoldSpec(key, value, schema, gateOpts) }),
    // Run every code default through the SAME gate `promote` uses; the report says whether each default could
    // itself go live. The caller decides the policy (throw at boot, warn) on report.ok.
    checkDefaults: () => core.checkDefaults((key, value) => evalScaffoldSpec(key, value, schema, gateOpts)),
  };
}
