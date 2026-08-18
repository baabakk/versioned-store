// @versioned-store/cli tests. A string-payload store with a gate that refuses any value containing "BAD", and
// an ASYNC audit sink that needs a live "session", so the tests can prove the runner drains before it closes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDrainableSink,
  createInMemoryBackend,
  createVersionedStore,
  type DefaultsGate,
} from "@versioned-store/core";
import { createStoreCli, makeDescriptor, type CliCommand, type GatedPromote, type StoreDescriptor } from "./index.js";

function makeDomain(domain: string, defaults: Record<string, string>) {
  const persisted: string[] = []; // promote-accepted rows that actually landed in the "collection"
  let sessionOpen = true;
  const sink = createDrainableSink(async (e) => {
    await Promise.resolve(); // defer like a networked insert, past the synchronous emit
    if (!sessionOpen) throw new Error("Cannot use a session that has ended");
    if (e.type === "promote-accepted") persisted.push(`${e.key}@v${e.version}`);
  });
  const store = createVersionedStore<string>(
    {
      domain,
      defaults,
      hash: (v) => v,
      toDoc: (v) => ({ v }),
      fromDoc: (d) => (typeof d.v === "string" ? d.v : null),
      onEvent: sink.onEvent,
    },
    createInMemoryBackend(),
  );
  // A value containing "BAD" fails the gate: promote must refuse it, and it must show up as an unhealthy default.
  const gate: DefaultsGate<string> = (_k, v) => ({
    passed: !v.includes("BAD"),
    failures: v.includes("BAD") ? ["value contains BAD"] : [],
  });
  const gatedPromote: GatedPromote = (k, ver, o) => store.promote(k, ver, { ...o, gate: (v) => gate(k, v) });
  const descriptor: StoreDescriptor<string> = {
    domain,
    store,
    promote: gatedPromote,
    checkDefaults: () => store.checkDefaults(gate),
    parsePayload: (raw) => raw,
    renderForDiff: (v) => v,
    drain: () => sink.drain(),
  };
  return {
    descriptor,
    command: makeDescriptor(descriptor),
    persisted,
    openSession: () => {
      sessionOpen = true;
    },
    endSession: () => {
      sessionOpen = false;
    },
  };
}

function makeCli(commands: CliCommand[], opts?: { connect?: () => Promise<void>; close?: () => Promise<void> }) {
  const out: string[] = [];
  const err: string[] = [];
  const cli = createStoreCli({
    commands,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    connect: opts?.connect,
    close: opts?.close,
    prog: "test-admin",
  });
  return { cli, out, err };
}

describe("@versioned-store/cli — verbs", () => {
  it("seed then list shows every registered domain's keys (surface covers all domains)", async () => {
    const prompt = makeDomain("prompt", { greet: "hello" });
    const config = makeDomain("config", { guide: "doctrine" });
    const { cli, out } = makeCli([prompt.command, config.command]);

    assert.equal(await cli.run(["seed"]), 0);
    out.length = 0;
    assert.equal(await cli.run(["list"]), 0);

    assert.ok(out.some((l) => l.includes("[prompt]")) && out.some((l) => l.includes("greet")));
    assert.ok(out.some((l) => l.includes("[config]")) && out.some((l) => l.includes("guide")));
  });

  it("promote is GATED: a BAD version is refused (exit 1), a clean one is accepted (exit 0)", async () => {
    const prompt = makeDomain("prompt", { greet: "hello" });
    const { cli, out, err } = makeCli([prompt.command]);
    await cli.run(["seed"]); // greet -> v1 active

    assert.equal(await cli.run(["add", "greet", "hi BAD"]), 0); // v2, inactive
    const refused = await cli.run(["promote", "greet", "2"]);
    assert.equal(refused, 1);
    assert.ok(err.some((l) => /BAD/.test(l)), "the gate failure reached stderr");

    out.length = 0;
    assert.equal(await cli.run(["add", "greet", "hi there"]), 0); // v3
    assert.equal(await cli.run(["promote", "greet", "3"]), 0);
    assert.ok(out.some((l) => /promoted "greet" -> v3/.test(l)));
  });

  it("revert is the UNGATED kill-switch: it re-promotes the code default even over a live edit", async () => {
    const prompt = makeDomain("prompt", { greet: "hello" });
    const { cli, out } = makeCli([prompt.command]);
    await cli.run(["seed"]);
    await cli.run(["add", "greet", "edited"]);
    await cli.run(["promote", "greet", "2"]);

    out.length = 0;
    const code = await cli.run(["revert", "greet"]);
    assert.equal(code, 0);
    assert.ok(out.some((l) => /reverted "greet"/.test(l) && /UNGATED/.test(l)));
    // the active value is back to the in-code default
    const active = await prompt.command.active("greet");
    assert.equal(active?.rendered, "hello");
  });

  it("health runs across ALL domains and exits 1 when ANY domain has an unhealthy default", async () => {
    const good = makeDomain("prompt", { greet: "hello" });
    const bad = makeDomain("config", { guide: "this is BAD" }); // a default that cannot pass its own gate
    const { cli, out } = makeCli([good.command, bad.command]);

    const code = await cli.run(["health"]);
    assert.equal(code, 1, "any unhealthy domain fails the whole health check");
    assert.ok(out.some((l) => l.includes("[prompt]") && /OK/.test(l)));
    assert.ok(out.some((l) => l.includes("[config]") && /FAILED/.test(l)));
    assert.ok(out.some((l) => /guide/.test(l) && /BAD/.test(l)));
  });

  it("a key-targeted verb needs --domain when more than one domain is registered", async () => {
    const a = makeDomain("prompt", { greet: "hello" });
    const b = makeDomain("config", { guide: "doctrine" });
    const { cli, err } = makeCli([a.command, b.command]);
    await cli.run(["seed"]);

    const ambiguous = await cli.run(["list", "greet"]);
    assert.equal(ambiguous, 1);
    assert.ok(err.some((l) => /--domain/.test(l)));

    const selected = await cli.run(["list", "greet", "--domain", "prompt"]);
    assert.equal(selected, 0);
  });

  it("--help exits 0 with usage; an unknown verb exits 2", async () => {
    const a = makeDomain("prompt", { greet: "hello" });
    const { cli, out } = makeCli([a.command]);
    assert.equal(await cli.run(["--help"]), 0);
    assert.ok(out.some((l) => /Verbs:/.test(l)));
    assert.equal(await cli.run(["frobnicate"]), 2);
  });
});

describe("@versioned-store/cli — lifecycle (TD-VS-15: the runner drains the audit sink before close)", () => {
  it("a CLI promote's audit row lands even though close() ends the session, because drain runs first", async () => {
    const prompt = makeDomain("prompt", { greet: "hello" });
    // Model one process per invocation: connect() opens the audit session, close() ends it (like
    // initStoreConnection / closeStoreConnection). The runner must drain BETWEEN the verb and close().
    const { cli } = makeCli([prompt.command], {
      connect: async () => prompt.openSession(),
      close: async () => prompt.endSession(),
    });

    await cli.run(["seed"]);
    await cli.run(["add", "greet", "v2 text"]);
    const code = await cli.run(["promote", "greet", "2"]); // emits promote-accepted -> async sink write

    assert.equal(code, 0);
    // The write survived: drain awaited it before close() ended the session. Without the drain it would be lost.
    assert.ok(prompt.persisted.includes("greet@v2"), "the promote-accepted audit row was persisted");
  });

  it("drain runs even when the verb throws, and a drain failure does not mask the verb's exit code", async () => {
    const prompt = makeDomain("prompt", { greet: "hello" });
    let drained = false;
    const command: CliCommand = { ...prompt.command, drain: async () => void (drained = true) };
    const { cli } = makeCli([command]);
    await cli.run(["seed"]);

    const code = await cli.run(["promote", "greet", "99"]); // version 99 does not exist -> throws -> exit 1
    assert.equal(code, 1);
    assert.equal(drained, true, "the drain ran in the finally even though the verb threw");
  });
});

describe("@versioned-store/cli — construction guards", () => {
  it("rejects an empty command list and duplicate domains", () => {
    assert.throws(() => createStoreCli({ commands: [] }), /at least one command/);
    const a = makeDomain("dup", { k: "v" });
    const b = makeDomain("dup", { k: "v2" });
    assert.throws(() => createStoreCli({ commands: [a.command, b.command] }), /duplicate domain "dup"/);
  });
});
