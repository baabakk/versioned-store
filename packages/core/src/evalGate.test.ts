// Tests for the M6 eval-gate ladder (design 08 M6). All tiers are exercised offline: Tier 2 (golden-output)
// is pure; Tier 3 (LLM-judge) is driven by STUB judge functions (deterministic scores) + the skip-when-null
// path, so no real provider is needed. The final test drives an async gate through the core's promote.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildGate, composeGates, goldenOutputGate, llmJudgeGate, runAssertion, type Assertion } from "./evalGate.js";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";

describe("M6 eval-gate: declarative assertions", () => {
  const cases: Array<[Assertion, string, boolean]> = [
    [{ type: "equals", value: "hi" }, "hi", true],
    [{ type: "equals", value: "hi" }, "ho", false],
    [{ type: "contains", value: "ell" }, "hello", true],
    [{ type: "contains", value: "xyz" }, "hello", false],
    [{ type: "not-contains", value: "bad" }, "good", true],
    [{ type: "not-contains", value: "oo" }, "good", false],
    [{ type: "regex", value: "^h\\w+o$" }, "hello", true],
    [{ type: "regex", value: "^z" }, "hello", false],
    [{ type: "is-json" }, '{"a":1}', true],
    [{ type: "is-json" }, "{not json", false],
    [{ type: "min-length", value: 3 }, "abc", true],
    [{ type: "min-length", value: 5 }, "abc", false],
  ];
  for (const [a, output, expected] of cases) {
    test(`${a.type} on ${JSON.stringify(output)} -> ${expected}`, () => {
      assert.equal(runAssertion(a, output).passed, expected);
    });
  }
  test("a malformed regex is a failure, not a throw", () => {
    assert.equal(runAssertion({ type: "regex", value: "(" }, "x").passed, false);
  });
});

describe("M6 eval-gate: Tier 2 golden-output (offline)", () => {
  const render = (v: { tpl: string }, input: { name: string }) => v.tpl.replace("{name}", input.name);

  test("passes when every assertion holds", async () => {
    const gate = goldenOutputGate<{ tpl: string }, { name: string }>({
      render,
      goldens: [{ input: { name: "Ada" }, assert: [{ type: "contains", value: "Ada" }, { type: "min-length", value: 3 }] }],
    });
    const r = await gate({ tpl: "hello {name}" });
    assert.equal(r.passed, true);
    assert.deepEqual(r.failures, []);
  });

  test("fails with per-golden messages", async () => {
    const gate = goldenOutputGate<{ tpl: string }, { name: string }>({
      render,
      goldens: [{ name: "greets", input: { name: "Ada" }, assert: [{ type: "contains", value: "Bob" }] }],
    });
    const r = await gate({ tpl: "hello {name}" });
    assert.equal(r.passed, false);
    assert.match(r.failures[0], /greets:/);
  });

  test("a render that throws is a failure, not a crash", async () => {
    const gate = goldenOutputGate<{ x: number }, null>({
      render: () => {
        throw new Error("boom");
      },
      goldens: [{ input: null, assert: [] }],
    });
    const r = await gate({ x: 1 });
    assert.equal(r.passed, false);
    assert.match(r.failures[0], /render threw: boom/);
  });
});

describe("M6 eval-gate: Tier 3 LLM-judge (async, skip-when-no-provider)", () => {
  const render = (v: { text: string }) => v.text;

  test("judge === null skips the whole tier (passes)", async () => {
    const gate = llmJudgeGate<{ text: string }, null>({ render, judge: null, goldens: [{ input: null, rubric: "any" }] });
    assert.equal((await gate({ text: "x" })).passed, true);
  });

  test("a high score passes, a low score fails", async () => {
    const g = (judge: () => Promise<number>) =>
      llmJudgeGate<{ text: string }, null>({ render, judge, goldens: [{ input: null, rubric: "be good", threshold: 0.7 }] });
    assert.equal((await g(async () => 0.9)({ text: "x" })).passed, true);
    const low = await g(async () => 0.3)({ text: "x" });
    assert.equal(low.passed, false);
    assert.match(low.failures[0], /score 0\.30 < threshold 0\.7/);
  });

  test("a per-case null score is skipped, not a failure", async () => {
    const gate = llmJudgeGate<{ text: string }, null>({ render, judge: async () => null, goldens: [{ input: null, rubric: "x" }] });
    assert.equal((await gate({ text: "x" })).passed, true);
  });
});

describe("M6 eval-gate: compose + buildGate + core integration", () => {
  test("composeGates ANDs the tiers and merges failures", async () => {
    const pass = () => ({ passed: true, failures: [] });
    const failA = () => ({ passed: false, failures: ["A"] });
    const failB = () => ({ passed: false, failures: ["B"] });
    assert.equal((await composeGates(pass, pass)("x")).passed, true);
    const r = await composeGates(failA, pass, failB)("x");
    assert.equal(r.passed, false);
    assert.deepEqual(r.failures, ["A", "B"]);
  });

  test("buildGate selects only the configured tiers", async () => {
    const gate = buildGate<{ text: string }, null>({
      deterministic: (v) => ({ passed: v.text.length > 0, failures: v.text ? [] : ["empty"] }),
    });
    assert.equal((await gate({ text: "x" })).passed, true);
    assert.equal((await gate({ text: "" })).passed, false);
  });

  test("an async gate refuses then accepts a promote through the core", async () => {
    const cfg: VersionedStoreConfig<{ text: string }> = {
      domain: "m6",
      defaults: {},
      hash: (v) => v.text,
      toDoc: (v) => ({ text: v.text }),
      fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
    };
    const s = createVersionedStore(cfg, createInMemoryBackend());
    const gate = goldenOutputGate<{ text: string }, null>({
      render: (v) => v.text,
      goldens: [{ input: null, assert: [{ type: "contains", value: "ok" }] }],
    });
    await s.addVersion("k", { text: "bad" });
    await assert.rejects(() => s.promote("k", 1, { gate }));
    await s.addVersion("k", { text: "ok!" });
    await s.promote("k", 2, { gate });
    assert.equal((await s.getActiveVersion("k"))?.value.text, "ok!");
  });
});
