// checkDefaults (the fallback-soundness check): run every code default through a supplied per-key gate and
// report whether each could itself go live. Pure over cfg.defaults, no backend I/O, no throw, no event. The
// caller keeps the policy (throw at boot, warn, degrade) on report.ok.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryBackend } from "./backends/memory.js";
import { createVersionedStore, type GateResult } from "./versionedStore.js";

// A minimal string-payload store: hash = identity, doc = { v }.
function makeStore(defaults: Record<string, string>) {
  return createVersionedStore<string>(
    { domain: "test", defaults, hash: (v) => v, toDoc: (v) => ({ v }), fromDoc: (d) => (typeof d.v === "string" ? d.v : null) },
    createInMemoryBackend(),
  );
}

// A gate that fails any value containing "BAD".
const noBadGate = (_key: string, value: string): GateResult => ({
  passed: !value.includes("BAD"),
  failures: value.includes("BAD") ? ["contains BAD"] : [],
});

describe("checkDefaults", () => {
  it("reports ok=true when every default passes the gate", async () => {
    const report = await makeStore({ a: "fine", b: "also fine" }).checkDefaults(noBadGate);
    assert.equal(report.ok, true);
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every((r) => r.passed));
  });

  it("reports ok=false and names the failing key + reasons when a default fails its gate", async () => {
    const report = await makeStore({ a: "fine", b: "this is BAD" }).checkDefaults(noBadGate);
    assert.equal(report.ok, false);
    const bad = report.results.find((r) => r.key === "b");
    assert.ok(bad && !bad.passed);
    assert.deepEqual(bad.failures, ["contains BAD"]);
    assert.equal(report.results.find((r) => r.key === "a")?.passed, true);
  });

  it("is pure: reads only cfg.defaults, so it works with nothing seeded and never throws", async () => {
    // No seedDefaults() / ensureIndexes() called first; checkDefaults must not touch the backend.
    const report = await makeStore({ a: "fine" }).checkDefaults(() => ({ passed: true, failures: [] }));
    assert.equal(report.ok, true);
  });

  it("supports an async gate (the LLM-judge / golden-output tier)", async () => {
    const report = await makeStore({ a: "BAD" }).checkDefaults(async (_k, v) => ({
      passed: !v.includes("BAD"),
      failures: v.includes("BAD") ? ["async BAD"] : [],
    }));
    assert.equal(report.ok, false);
    assert.deepEqual(report.results[0].failures, ["async BAD"]);
  });

  it("passes the KEY to the gate, because gates are per-key", async () => {
    const seen: string[] = [];
    await makeStore({ x: "1", y: "2" }).checkDefaults((key) => {
      seen.push(key);
      return { passed: true, failures: [] };
    });
    assert.deepEqual(seen.sort(), ["x", "y"]);
  });
});
