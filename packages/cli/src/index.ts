// @versioned-store/cli — a descriptor-driven operator surface for @versioned-store stores.
//
// The problem this removes: a store is only as operable as its admin surface, and today that surface is
// re-hand-rolled per domain, per consumer, with the gate re-wired or skipped each time. A hand-rolled surface
// silently drops a payload family (a store whose revert verb was never wired is only discovered during an
// incident), and its audit sink loses writes on a short-lived process (a CLI closes the backend before the
// fire-and-forget write lands). Both were found in a live consumer's rollback rehearsal.
//
// The kit takes ONE descriptor per store domain and drives a uniform verb set. Two properties are load-bearing:
//   1. `promote` is the domain's GATED promote; the raw ungated `promote(gate?)` is not on the descriptor's
//      store surface (Omit), so an ungated promote is unreachable through the CLI.
//   2. `health` runs `checkDefaults` across EVERY registered domain, so a domain with no operator wiring is
//      visible (it is either registered, and covered, or absent, and there is nothing to operate).
//   3. The runner owns a connect -> verb -> drain -> close lifecycle, so an async audit sink's writes are
//      flushed before the backend closes (see createDrainableSink / TD-VS-15).

import {
  VersionedStoreError,
  type DefaultsGate,
  type DefaultsHealthReport,
  type KeySummary,
  type Resolved,
  type SeedResult,
  type SyncResult,
  type VersionInfo,
  type VersionedStore,
} from "@versioned-store/core";

/**
 * A gated promote: move the active label to an existing version, with the domain's eval-gate baked in. It has
 * no raw `gate` parameter, which is the point: the only promote a descriptor exposes is the gated one, so a
 * CLI cannot move a label to a version the gate would refuse.
 */
export type GatedPromote = (
  key: string,
  version: number,
  opts?: { by?: string; note?: string; label?: string },
) => Promise<void>;

/**
 * The typed authoring shape for one store domain. Build it from a domain facade's PUBLIC surface (its `.core`,
 * its gated `promote`, its zero-arg `checkDefaults`), then erase the payload type with `makeDescriptor`.
 *
 * `store` is the facade's core store with `promote` OMITTED, so the runner physically cannot reach the ungated
 * promote; promotion goes only through the gated `promote` below. `checkDefaults` is the facade's zero-arg
 * variant (the domain gate already baked in), which is exactly the `health` verb.
 */
export interface StoreDescriptor<T> {
  /** Unique domain name: the CLI dispatch key (`--domain <name>`) and the display label. */
  domain: string;
  /** The store's read + admin verbs. Ungated `promote` is intentionally absent; use the gated `promote` below. */
  store: Omit<VersionedStore<T>, "promote">;
  /** The domain's GATED promote (a facade's `promote`). The runner's only promote path. */
  promote: GatedPromote;
  /** Health across every code default (a facade's zero-arg `checkDefaults`; the domain gate is baked in). */
  checkDefaults(): Promise<DefaultsHealthReport>;
  /** Parse a single CLI string argument into a payload for `add`. Throw a clear message on malformed input. */
  parsePayload(raw: string): T;
  /**
   * Optional per-key gate. When supplied, `seed` and `sync` verify each code default through it before
   * promoting (verify-on-seed): an unsound default is refused, not made active. Facade-backed descriptors can
   * leave this off (their own `seedDefaults` already gates); a core-direct descriptor should pass its gate here
   * so the operator `seed`/`sync` verbs cannot promote an unsound default either.
   */
  gate?: DefaultsGate<T>;
  /** Pretty-print a payload for `diff` (default: pretty JSON). */
  renderForDiff?(value: T): string;
  /** Flush the audit sink before the runner closes the backend (wire a `createDrainableSink().drain`). */
  drain?(): Promise<void>;
}

/**
 * A payload-type-erased, runnable command for one domain. `makeDescriptor` captures `T` inside its closures and
 * returns this monomorphic shape, so a runner can hold commands for many domains in one array without `any`.
 * All display outputs are already rendered to strings; the payload type never leaves the closure.
 */
export interface CliCommand {
  readonly domain: string;
  keys(): Promise<KeySummary[]>;
  versions(key: string): Promise<VersionInfo[]>;
  /** The active version's identity + rendered value, or null when the key is unseeded. */
  active(key: string): Promise<{ version: number; sha256: string; rendered: string } | null>;
  /** A specific version's identity + rendered value, or null when it does not exist. */
  version(key: string, version: number): Promise<{ version: number; sha256: string; rendered: string } | null>;
  /** The in-code default's identity + rendered value (sentinel v0), or null when the key has no default. */
  codeDefault(key: string): { sha256: string; rendered: string } | null;
  add(key: string, raw: string, opts: { by?: string; note?: string }): Promise<number>;
  promote(key: string, version: number, opts: { by?: string; note?: string; label?: string }): Promise<void>;
  revert(key: string, opts: { by?: string; note?: string }): Promise<number>;
  seed(): Promise<SeedResult[]>;
  sync(): Promise<SyncResult[]>;
  health(): Promise<DefaultsHealthReport>;
  ensureIndexes(): Promise<void>;
  /** Await the domain's audit-sink writes. A no-op when the descriptor wired no drain. */
  drain(): Promise<void>;
}

/**
 * Erase a typed descriptor into a runnable command. The payload type `T` is captured in the closures below and
 * never appears in the returned interface, which is what lets a runner hold many domains' commands together.
 */
export function makeDescriptor<T>(d: StoreDescriptor<T>): CliCommand {
  const render = (value: T): string => (d.renderForDiff ? d.renderForDiff(value) : JSON.stringify(value, null, 2));
  const shaped = (r: Resolved<T> | null) =>
    r ? { version: r.version, sha256: r.sha256, rendered: render(r.value) } : null;
  return {
    domain: d.domain,
    keys: () => d.store.listKeys(),
    versions: (key) => d.store.listVersions(key),
    active: async (key) => shaped(await d.store.getActiveVersion(key)),
    version: async (key, version) => shaped(await d.store.getVersion(key, version)),
    codeDefault: (key) => {
      const r = d.store.codeDefault(key);
      return r ? { sha256: r.sha256, rendered: render(r.value) } : null;
    },
    add: (key, raw, opts) => d.store.addVersion(key, d.parsePayload(raw), opts),
    promote: (key, version, opts) => d.promote(key, version, opts),
    revert: (key, opts) => d.store.revertToCodeDefault(key, opts),
    seed: () => d.store.seedDefaults(d.gate ? { gate: d.gate } : undefined),
    sync: () => d.store.syncDefaults(d.gate ? { gate: d.gate } : undefined),
    health: () => d.checkDefaults(),
    ensureIndexes: () => d.store.ensureIndexes(),
    drain: () => d.drain?.() ?? Promise.resolve(),
  };
}

export interface StoreCliOptions {
  /**
   * One command per store domain (build each with `makeDescriptor`). Verbs that target a key resolve to a
   * single domain (via `--domain`, or the sole registered one); `list`/`seed`/`sync`/`health` run across ALL
   * registered domains when `--domain` is omitted, which is what makes a dropped domain visible rather than
   * silent.
   */
  commands: CliCommand[];
  /** Open the backend before the verb (e.g. `await initStoreConnection().asPromise()`). */
  connect?: () => Promise<void>;
  /** Close the backend after the verb. Runs AFTER the audit-sink drain, never before it. */
  close?: () => Promise<void>;
  /** Normal output sink, one call per line (default: console.log). */
  out?: (line: string) => void;
  /** Error / usage sink, one call per line (default: console.error). */
  err?: (line: string) => void;
  /** Program name shown in usage (default: "store-admin"). */
  prog?: string;
  /** Default actor for `by` when `--by` is absent (e.g. `() => process.env.USER ?? "store-admin"`). */
  actor?: () => string;
}

export interface StoreCli {
  /** Parse argv (already sliced past node + script), run the verb, drain, close, and return an exit code. Never throws. */
  run(argv: string[]): Promise<number>;
}

const VERBS = new Set(["list", "add", "promote", "revert", "diff", "seed", "sync", "health"]);

interface ParsedArgs {
  verb?: string;
  help: boolean;
  domain?: string;
  by?: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let verb: string | undefined;
  let domain: string | undefined;
  let by: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--domain" || a === "-d") {
      domain = argv[++i];
      if (domain === undefined) throw new VersionedStoreError("--domain needs a value");
      continue;
    }
    if (a === "--by") {
      by = argv[++i];
      if (by === undefined) throw new VersionedStoreError("--by needs a value");
      continue;
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (verb === undefined) {
      verb = a;
      continue;
    }
    rest.push(a);
  }
  return { verb, help, domain, by, rest };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createStoreCli(opts: StoreCliOptions): StoreCli {
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const prog = opts.prog ?? "store-admin";
  const commands = opts.commands;

  if (commands.length === 0) throw new VersionedStoreError("createStoreCli: at least one command is required");
  const byDomain = new Map<string, CliCommand>();
  for (const c of commands) {
    if (byDomain.has(c.domain)) throw new VersionedStoreError(`createStoreCli: duplicate domain "${c.domain}"`);
    byDomain.set(c.domain, c);
  }
  const domainList = [...byDomain.keys()].join(", ");

  /** Resolve to a single domain for a key-targeted verb: the named one, or the sole registered one. */
  function selectOne(domain?: string): CliCommand {
    if (domain) {
      const c = byDomain.get(domain);
      if (!c) throw new VersionedStoreError(`unknown domain "${domain}" (registered: ${domainList})`);
      return c;
    }
    if (commands.length === 1) return commands[0];
    throw new VersionedStoreError(`multiple domains registered (${domainList}); pass --domain <name>`);
  }

  function actorOf(p: ParsedArgs): string {
    return p.by ?? opts.actor?.() ?? "store-admin";
  }

  function usage(): string {
    return [
      `Usage: ${prog} <verb> [args] [--domain <name>] [--by <actor>]`,
      ``,
      `Domains: ${domainList}`,
      `  A verb that targets a key needs --domain when more than one domain is registered.`,
      `  list / seed / sync / health run across ALL domains when --domain is omitted.`,
      ``,
      `Verbs:`,
      `  list [key]            List keys (all domains), or the versions of one key.`,
      `  add <key> <payload>   Add a new INACTIVE version parsed from <payload> (promote it to go live).`,
      `  promote <key> <ver>   Move the active label to <ver>. GATED: refused if <ver> fails its eval-gate.`,
      `  revert <key>          Kill-switch: re-promote the in-code default. UNGATED, by design.`,
      `  diff <key>            Compare the active version to the in-code default.`,
      `  seed                  Insert any unseeded code defaults (idempotent).`,
      `  sync                  Add + promote any code default whose content drifted from active.`,
      `  health                Run every code default through its gate. Exit 1 if any domain is unhealthy.`,
    ].join("\n");
  }

  async function verbList(p: ParsedArgs): Promise<number> {
    if (p.rest.length === 0) {
      const targets = p.domain ? [selectOne(p.domain)] : commands;
      for (const c of targets) {
        const keys = await c.keys();
        out(`[${c.domain}] ${keys.length} key(s)`);
        for (const k of keys) {
          out(`  ${k.key}  versions=${k.versions}  active=${k.activeVersion ?? "(none, serving code default)"}`);
        }
      }
      return 0;
    }
    const c = selectOne(p.domain);
    const key = p.rest[0];
    const versions = await c.versions(key);
    if (versions.length === 0) {
      out(`[${c.domain}] "${key}" has no stored versions (serving its code default)`);
      return 0;
    }
    out(`[${c.domain}] "${key}": ${versions.length} version(s)`);
    for (const v of versions) {
      const marker = v.active ? "  <-- ACTIVE" : "";
      const note = v.note ? `  note="${v.note}"` : "";
      out(`  v${v.version}  ${v.sha256.slice(0, 12)}  ${v.createdAtIso}  by=${v.createdBy}${note}${marker}`);
    }
    return 0;
  }

  async function verbAdd(p: ParsedArgs): Promise<number> {
    const c = selectOne(p.domain);
    const [key, raw] = p.rest;
    if (!key || raw === undefined) throw new VersionedStoreError("usage: add <key> <payload> [--domain <name>]");
    const version = await c.add(key, raw, { by: actorOf(p) });
    out(`[${c.domain}] added "${key}" -> v${version} (INACTIVE; promote it to go live)`);
    return 0;
  }

  async function verbPromote(p: ParsedArgs): Promise<number> {
    const c = selectOne(p.domain);
    const [key, versionStr, note] = p.rest;
    if (!key || !versionStr) throw new VersionedStoreError("usage: promote <key> <version> [note] [--domain <name>]");
    const version = Number(versionStr);
    if (!Number.isInteger(version) || version < 1) {
      throw new VersionedStoreError(`invalid version "${versionStr}" (must be a positive integer)`);
    }
    // GATED inside the descriptor: if the eval-gate refuses, c.promote throws and the run() catch exits non-zero.
    await c.promote(key, version, { by: actorOf(p), ...(note ? { note } : {}) });
    out(`[${c.domain}] promoted "${key}" -> v${version} (gate passed, active label moved)${note ? `: ${note}` : ""}`);
    return 0;
  }

  async function verbRevert(p: ParsedArgs): Promise<number> {
    const c = selectOne(p.domain);
    const [key] = p.rest;
    if (!key) throw new VersionedStoreError("usage: revert <key> [--domain <name>]");
    const version = await c.revert(key, { by: actorOf(p), note: "kill-switch: reverted to in-code default" });
    out(`[${c.domain}] reverted "${key}" -> v${version} (in-code default re-promoted, UNGATED kill-switch)`);
    return 0;
  }

  async function verbDiff(p: ParsedArgs): Promise<number> {
    const c = selectOne(p.domain);
    const [key] = p.rest;
    if (!key) throw new VersionedStoreError("usage: diff <key> [--domain <name>]");
    const def = c.codeDefault(key);
    const active = await c.active(key);
    out(`[${c.domain}] "${key}": code default vs active`);
    out(`  code default (v0): ${def ? def.sha256.slice(0, 12) : "(none)"}`);
    out(`  active:            ${active ? `v${active.version} ${active.sha256.slice(0, 12)}` : "(none, serving code default)"}`);
    if (def && active && def.sha256 === active.sha256) {
      out(`  => identical (the active version IS the in-code default)`);
    } else if (def && active) {
      out(`  => DIFFERS`);
      out(`  --- code default ---`);
      for (const line of def.rendered.split("\n")) out(`  ${line}`);
      out(`  --- active v${active.version} ---`);
      for (const line of active.rendered.split("\n")) out(`  ${line}`);
    }
    return 0;
  }

  async function verbSeedSync(p: ParsedArgs, which: "seed" | "sync"): Promise<number> {
    const targets = p.domain ? [selectOne(p.domain)] : commands;
    let refusedAny = false;
    for (const c of targets) {
      if (which === "seed") {
        const res = await c.seed();
        const seeded = res.filter((r) => r.seeded).length;
        const refused = res.filter((r) => r.refused);
        out(`[${c.domain}] seeded ${seeded}/${res.length} key(s) (${res.length - seeded - refused.length} already present, ${refused.length} refused)`);
        for (const r of refused) out(`  x refused "${r.key}": ${(r.failures ?? []).join("; ")}`);
        if (refused.length) refusedAny = true;
      } else {
        const res = await c.sync();
        const counts = { seeded: 0, updated: 0, unchanged: 0, refused: 0 };
        for (const r of res) counts[r.action] += 1;
        out(`[${c.domain}] sync: seeded=${counts.seeded} updated=${counts.updated} unchanged=${counts.unchanged} refused=${counts.refused}`);
        for (const r of res) if (r.action === "refused") out(`  x refused "${r.key}": ${(r.failures ?? []).join("; ")}`);
        if (counts.refused) refusedAny = true;
      }
    }
    // A refused default is an unsound code default the seed/sync would otherwise have promoted. Exit non-zero
    // so an operator or a CI step that runs `seed`/`sync` fails loudly rather than silently leaving it unseeded.
    return refusedAny ? 1 : 0;
  }

  async function verbHealth(p: ParsedArgs): Promise<number> {
    // Runs across EVERY registered domain by default: the surface-completeness guarantee. A domain that ships
    // no operator wiring is simply absent from the registry (there is nothing to operate), and every domain
    // that IS registered is health-checked, so a dropped payload family cannot hide.
    const targets = p.domain ? [selectOne(p.domain)] : commands;
    let ok = true;
    for (const c of targets) {
      const report = await c.health();
      if (!report.ok) ok = false;
      const failing = report.results.filter((r) => !r.passed);
      out(`[${c.domain}] defaults health: ${report.ok ? "OK" : "FAILED"} (${report.results.length} default(s), ${failing.length} failing)`);
      for (const r of failing) out(`  x ${r.key}: ${r.failures.join("; ")}`);
    }
    return ok ? 0 : 1;
  }

  async function dispatch(p: ParsedArgs): Promise<number> {
    switch (p.verb) {
      case "list":
        return verbList(p);
      case "add":
        return verbAdd(p);
      case "promote":
        return verbPromote(p);
      case "revert":
        return verbRevert(p);
      case "diff":
        return verbDiff(p);
      case "seed":
        return verbSeedSync(p, "seed");
      case "sync":
        return verbSeedSync(p, "sync");
      case "health":
        return verbHealth(p);
      default:
        // Unreachable: run() validates the verb against VERBS before dispatch.
        throw new VersionedStoreError(`unhandled verb "${p.verb}"`);
    }
  }

  async function run(argv: string[]): Promise<number> {
    let p: ParsedArgs;
    try {
      p = parseArgs(argv);
    } catch (e) {
      err(`${prog}: ${msg(e)}`);
      out(usage());
      return 2;
    }
    if (p.help) {
      out(usage());
      return 0;
    }
    if (!p.verb) {
      err(`${prog}: a verb is required`);
      out(usage());
      return 2;
    }
    if (!VERBS.has(p.verb)) {
      err(`${prog}: unknown verb "${p.verb}"`);
      out(usage());
      return 2;
    }

    // connect -> verb -> DRAIN -> close. The drain flushes each domain's audit sink before the backend closes,
    // so a promote's audit row lands even though a CLI process is about to exit (see createDrainableSink).
    if (opts.connect) await opts.connect();
    try {
      return await dispatch(p);
    } catch (e) {
      err(`${prog}: ${msg(e)}`);
      return 1;
    } finally {
      for (const c of commands) {
        try {
          await c.drain();
        } catch (e) {
          err(`${prog}: audit drain failed for "${c.domain}": ${msg(e)}`);
        }
      }
      if (opts.close) {
        try {
          await opts.close();
        } catch (e) {
          err(`${prog}: close failed: ${msg(e)}`);
        }
      }
    }
  }

  return { run };
}
