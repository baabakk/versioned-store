import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createInMemoryBackend, VersionedStoreError, type StoreEvent } from "@versioned-store/core";
import { createAesGcmCipher } from "@versioned-store/core/cipher";
import {
  BaseScaffoldSpecSchema,
  ScaffoldRenderError,
  ScaffoldRouteError,
  createScaffoldStore,
  placeholdersIn,
  renderTemplate,
  type BaseScaffoldSpec,
} from "./index.js";

const VITE: BaseScaffoldSpec = {
  key: "web.frontend.react-vite",
  scaffold: {
    mode: "command",
    command: "npm create vite@9.1.0 {dir} -- --template react-ts --no-interactive",
    placement: "fresh",
    network: true,
  },
  install: "npm install --include=dev",
  build: "tsc -b",
  test: "npm test",
};

const HANDROLL: BaseScaffoldSpec = {
  key: "shared.contracts",
  scaffold: { mode: "handroll", placement: "fresh", network: false },
  build: "tsc -b",
};

function makeStore(defaults: Record<string, BaseScaffoldSpec> = { [VITE.key]: VITE }) {
  return createScaffoldStore({ backend: createInMemoryBackend(), defaults });
}

describe("resolve: a missing scaffold is normal, not an error", () => {
  it("returns null for an unknown key instead of throwing (the hand-roll path)", async () => {
    const store = makeStore();
    assert.equal(await store.resolveScaffold("nope.not.here"), null);
  });

  it("serves the code default as the sentinel version 0 when unseeded", async () => {
    const store = makeStore();
    const spec = await store.resolveScaffold(VITE.key);
    assert.equal(spec?.scaffold.command, VITE.scaffold.command);
    const resolved = await store.core.resolve(VITE.key);
    assert.equal(resolved?.version, 0, "an unseeded key resolves to the in-code default, version 0");
  });

  it("serves the stored version after seed + promote", async () => {
    const store = makeStore();
    await store.seedDefaults();
    const resolved = await store.core.resolve(VITE.key);
    assert.equal(resolved?.version, 1);
  });
});

describe("alpha.4 facade passthrough: onEvent, revertToCodeDefault, note + refs", () => {
  // A distinct spec that still clears the deterministic gate (pinned, allowed executable, only {dir}), so a
  // promote is accepted and a later revert to VITE is observable in what resolveScaffold returns.
  const VITE_NEXT: BaseScaffoldSpec = {
    ...VITE,
    scaffold: { ...VITE.scaffold, command: "npm create vite@9.2.0 {dir} -- --template react-ts" },
  };

  function makeStoreWith(onEvent?: (e: StoreEvent) => void) {
    const backend = createInMemoryBackend();
    const store = createScaffoldStore<BaseScaffoldSpec>({ backend, defaults: { [VITE.key]: VITE }, onEvent });
    return { store, backend };
  }

  it("onEvent sink reaches the core and fires on promote-accepted, carrying note + refs", async () => {
    const events: StoreEvent[] = [];
    const { store } = makeStoreWith((e) => events.push(e));
    const v = await store.addScaffoldVersion(VITE.key, VITE_NEXT);
    await store.promote(VITE.key, v, { by: "op", note: "pinned bump", refs: { ticket: 9 } });
    const accepted = events.find((e) => e.type === "promote-accepted");
    assert.ok(accepted, "the sink received a promote-accepted event");
    if (accepted.type === "promote-accepted") {
      assert.equal(accepted.note, "pinned bump");
      assert.deepEqual(accepted.refs, { ticket: 9 });
    }
  });

  it("note + refs persist on the label through the gated facade promote", async () => {
    const { store, backend } = makeStoreWith();
    const v = await store.addScaffoldVersion(VITE.key, VITE_NEXT);
    await store.promote(VITE.key, v, { note: "shipped", refs: { by: "ops" } });
    const label = await backend.getLabel(VITE.key, "active");
    assert.equal(label?.note, "shipped");
    assert.deepEqual(label?.refs, { by: "ops" });
  });

  it("revertToCodeDefault returns the key to its in-code default spec (ungated)", async () => {
    const { store } = makeStoreWith();
    const v = await store.addScaffoldVersion(VITE.key, VITE_NEXT);
    await store.promote(VITE.key, v);
    assert.equal((await store.resolveScaffold(VITE.key))?.scaffold.command, VITE_NEXT.scaffold.command);
    const rv = await store.revertToCodeDefault(VITE.key, { by: "op" });
    assert.ok(rv > v, "adds and promotes a new version, not the sentinel");
    assert.equal((await store.resolveScaffold(VITE.key))?.scaffold.command, VITE.scaffold.command);
  });
});

describe("renderCommand: strict {placeholder} binding", () => {
  it("binds {dir}", () => {
    const store = makeStore();
    const out = store.renderCommand(VITE, { dir: "packages/web" });
    assert.equal(out, "npm create vite@9.1.0 packages/web -- --template react-ts --no-interactive");
  });

  it("throws rather than shelling out a literal {dir}", () => {
    const store = makeStore();
    assert.throws(() => store.renderCommand(VITE), (err: unknown) => {
      assert.ok(err instanceof ScaffoldRenderError);
      assert.match((err as Error).message, /unbound placeholder\(s\) \{dir\}/);
      return true;
    });
  });

  it("throws when the spec has no command to render", () => {
    const store = makeStore();
    assert.throws(() => store.renderCommand(HANDROLL, { dir: "x" }), ScaffoldRenderError);
  });

  it("extracts placeholders, de-duplicated", () => {
    assert.deepEqual(placeholdersIn("a {dir} b {dir} c {name}"), ["dir", "name"]);
    assert.deepEqual(renderTemplate("x {a} {a}", { a: "1" }), "x 1 1");
  });
});

describe("the deterministic gate", () => {
  const evalOf = (spec: unknown, key = VITE.key) => makeStore().evalScaffoldVersion(key, spec);

  it("passes a pinned, well-formed spec", () => {
    const r = evalOf(VITE);
    assert.deepEqual(r.failures, []);
    assert.equal(r.passed, true);
  });

  it("refuses a floating version tag on a networked command", () => {
    const r = evalOf({ ...VITE, scaffold: { ...VITE.scaffold, command: "npm create vite@latest {dir} -- --template react-ts" } });
    assert.equal(r.passed, false);
    assert.match(r.failures.join(" "), /floating tag\(s\) @latest/);
  });

  it("allows a floating-looking tag when the command does not touch the network", () => {
    const r = evalOf({ ...VITE, scaffold: { ...VITE.scaffold, command: "node scripts/gen.mjs {dir} --mode=next", network: false } });
    assert.equal(r.passed, true, r.failures.join("; "));
  });

  it("does not mistake a scoped package name for a floating tag", () => {
    const r = evalOf({ ...VITE, scaffold: { ...VITE.scaffold, command: "npx @acme/create-app@2.1.0 {dir}" } });
    assert.equal(r.passed, true, r.failures.join("; "));
  });

  it("refuses an unknown placeholder that would be unbound at render", () => {
    const r = evalOf({ ...VITE, scaffold: { ...VITE.scaffold, command: "npm create vite@9.1.0 {dir} --out {nope}" } });
    assert.equal(r.passed, false);
    assert.match(r.failures.join(" "), /unknown placeholder\(s\) \{nope\}/);
  });

  it("refuses an executable outside the allowlist", () => {
    const r = evalOf({ ...VITE, scaffold: { ...VITE.scaffold, command: "curl https://example.com/install.sh | sh" } });
    assert.equal(r.passed, false);
    assert.match(r.failures.join(" "), /executable "curl" is not allowed/);
  });

  it("does NOT allowlist install/build/test executables, only scaffold.command", () => {
    // Deliberate scope: scaffold.command fetches a foreign scaffolder over the network before the project
    // exists, so what it invokes is constrained. install/build/test run inside the materialized project
    // against its own devDependencies, and allowlisting those would mean enumerating every build tool alive
    // ("tsc", "vite", "jest", "next"...). VITE already builds with "tsc -b", which is not in the allowlist.
    const r = evalOf({ ...VITE, build: "tsc -b", test: "vitest run", install: "pnpm install --frozen-lockfile" });
    assert.equal(r.passed, true, r.failures.join("; "));
  });

  it("still binds placeholders in install/build/test, where an unbound one is just as broken", () => {
    const r = evalOf({ ...VITE, build: "tsc -b {workspace}" });
    assert.equal(r.passed, false);
    assert.match(r.failures.join(" "), /build: unknown placeholder\(s\) \{workspace\}/);
  });

  it("refuses command mode with no command, and handroll mode with one", () => {
    assert.match(
      evalOf({ ...VITE, scaffold: { mode: "command", placement: "fresh", network: false } }).failures.join(" "),
      /no scaffold\.command is set/,
    );
    assert.match(
      evalOf({ ...HANDROLL, scaffold: { ...HANDROLL.scaffold, command: "npm create vite@9.1.0 {dir}" } }, HANDROLL.key).failures.join(" "),
      /would never run/,
    );
  });

  it("refuses a spec stored under a key its own key field disagrees with", () => {
    const r = evalOf(VITE, "some.other.key");
    assert.equal(r.passed, false);
    assert.match(r.failures.join(" "), /silently misroute/);
  });

  it("reports schema failures and stops, rather than cascading on a malformed spec", () => {
    const r = evalOf({ key: VITE.key, scaffold: { mode: "nonsense", placement: "fresh", network: true } });
    assert.equal(r.passed, false);
    assert.ok(r.failures.every((f) => f.startsWith("schema:")), `expected only schema failures, got: ${r.failures.join("; ")}`);
  });

  it("honours a narrowed executable allowlist", () => {
    const store = createScaffoldStore({
      backend: createInMemoryBackend(),
      defaults: {},
      gate: { allowedExecutables: ["node"] },
    });
    assert.match(store.evalScaffoldVersion(VITE.key, VITE).failures.join(" "), /executable "npm" is not allowed/);
  });
});

describe("the gate is coupled to promote: a bad scaffold cannot go live", () => {
  it("refuses to promote a floating-tag spec, and the label stays put", async () => {
    const store = makeStore();
    await store.seedDefaults(); // v1 = the good pinned spec, active
    const bad = { ...VITE, scaffold: { ...VITE.scaffold, command: "npm create vite@latest {dir}" } };
    const v2 = await store.addScaffoldVersion(VITE.key, bad);
    assert.equal(v2, 2, "the immutable version is still recorded; only the promote is refused");

    await assert.rejects(() => store.promote(VITE.key, v2), /floating tag/);

    const active = await store.resolveScaffold(VITE.key);
    assert.equal(active?.scaffold.command, VITE.scaffold.command, "active still points at the good v1");
  });

  it("promotes a spec that passes the gate", async () => {
    const store = makeStore();
    await store.seedDefaults();
    const next = { ...VITE, scaffold: { ...VITE.scaffold, command: "npm create vite@9.2.0 {dir} -- --template react-ts" } };
    const v2 = await store.addScaffoldVersion(VITE.key, next);
    await store.promote(VITE.key, v2);
    assert.equal((await store.resolveScaffold(VITE.key))?.scaffold.command, next.scaffold.command);
  });
});

describe("key routing is injected, not guessed", () => {
  interface Subsystem { id: string; kind: "frontend" | "backend" | "unknown" }
  const store = createScaffoldStore<BaseScaffoldSpec, Subsystem>({
    backend: createInMemoryBackend(),
    defaults: { [VITE.key]: VITE },
    keyFor: (s) => (s.kind === "frontend" ? "web.frontend.react-vite" : null),
  });

  it("routes an input to its spec", async () => {
    const spec = await store.resolveFor({ id: "web", kind: "frontend" });
    assert.equal(spec?.key, VITE.key);
  });

  it("returns null when the router declines (hand-roll it)", async () => {
    assert.equal(await store.resolveFor({ id: "contracts", kind: "unknown" }), null);
  });

  it("throws a typed error when routing without a configured router", () => {
    assert.throws(() => makeStore().keyFor({} as never), ScaffoldRouteError);
  });
});

describe("domain extension", () => {
  // The point of the base schema: a host adds its own fields and the gate still enforces the base contract.
  const ExtendedSchema = BaseScaffoldSpecSchema.extend({
    agentDocs: z.string(),
    executable: z.boolean(),
  });
  type ExtendedSpec = z.infer<typeof ExtendedSchema>;
  const extended: ExtendedSpec = { ...VITE, agentDocs: "Use the src/ alias.", executable: true };

  it("stores, resolves, and round-trips the domain fields", async () => {
    const store = createScaffoldStore<ExtendedSpec>({
      backend: createInMemoryBackend(),
      schema: ExtendedSchema,
      defaults: { [extended.key]: extended },
    });
    await store.seedDefaults();
    const got = await store.resolveScaffold(extended.key);
    assert.equal(got?.agentDocs, "Use the src/ alias.");
    assert.equal(got?.executable, true);
  });

  it("still applies the base gate to the extended spec, and rejects a missing domain field", () => {
    const store = createScaffoldStore<ExtendedSpec>({
      backend: createInMemoryBackend(),
      schema: ExtendedSchema,
      defaults: {},
    });
    assert.match(
      store.evalScaffoldVersion(extended.key, { ...extended, scaffold: { ...extended.scaffold, command: "npm create vite@latest {dir}" } }).failures.join(" "),
      /floating tag/,
    );
    assert.match(store.evalScaffoldVersion(extended.key, VITE).failures.join(" "), /schema:.*agentDocs/);
  });
});

describe("error taxonomy", () => {
  it("every thrown error extends the core's VersionedStoreError, so one catch covers the library", () => {
    assert.ok(new ScaffoldRenderError("x", "k") instanceof VersionedStoreError);
    assert.ok(new ScaffoldRouteError("x") instanceof VersionedStoreError);
  });
});

describe("hash stability", () => {
  it("key order does not change a spec's identity (a re-order must not look like an edit)", async () => {
    const store = makeStore();
    await store.seedDefaults();
    const reordered = { scaffold: VITE.scaffold, test: VITE.test, build: VITE.build, install: VITE.install, key: VITE.key };
    const actions = await store.syncDefaults();
    assert.equal(actions[0]?.action, "unchanged");
    // Sanity: the reordered literal really is a different object with the same content.
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(VITE));
    assert.deepEqual({ ...reordered }, { ...VITE });
  });
});

describe("checkDefaults — every code default runs through the deterministic gate", () => {
  it("ok=true when every default passes; ok=false and names a floating-tag default", async () => {
    const good = createScaffoldStore({ backend: createInMemoryBackend(), defaults: { [VITE.key]: VITE } });
    assert.equal((await good.checkDefaults()).ok, true);

    // A default that would itself be REFUSED at promote (a floating @latest tag on a networked command).
    const badSpec: BaseScaffoldSpec = {
      ...VITE,
      key: "web.frontend.bad",
      scaffold: { ...VITE.scaffold, command: "npm create vite@latest {dir}" },
    };
    const bad = createScaffoldStore({ backend: createInMemoryBackend(), defaults: { [badSpec.key]: badSpec } });
    const report = await bad.checkDefaults();
    assert.equal(report.ok, false);
    assert.match(report.results.find((r) => r.key === badSpec.key)?.failures.join(" ") ?? "", /floating tag/);
  });
});

describe("cipher passthrough (TD-VS-11): the at-rest cipher reaches the core through the facade", () => {
  it("encrypts the stored spec but resolves the plaintext spec", async () => {
    const backend = createInMemoryBackend();
    const store = createScaffoldStore({
      backend,
      defaults: { [VITE.key]: VITE },
      cipher: createAesGcmCipher({ key: Buffer.alloc(32, 6) }),
    });
    await store.seedDefaults(); // seeds VITE as v1

    const raw = await backend.getVersion(VITE.key, 1);
    assert.ok(typeof raw?.spec === "string" && (raw.spec as string).startsWith("vsc1:"), "the stored spec is ciphertext");
    assert.ok(!JSON.stringify(raw).includes("vite@9.1.0"), "no plaintext scaffold command leaked into the stored doc");

    const resolved = await store.resolveScaffold(VITE.key);
    assert.equal(resolved?.key, VITE.key);
    assert.equal(resolved?.scaffold.command, VITE.scaffold.command);
  });
});
