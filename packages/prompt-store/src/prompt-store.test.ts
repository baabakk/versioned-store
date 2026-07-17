import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { createInMemoryBackend } from "@versioned-store/core";
import { createPromptStore } from "./index.js";

function makeStore() {
  return createPromptStore({
    backend: createInMemoryBackend(),
    defaults: { greeting: { text: "Hello, {{name}}!" } },
    varSchemas: { greeting: z.object({ name: z.string() }), strict: z.object({ name: z.string() }) },
    goldens: { greeting: [{ name: "World" }], strict: [{}] }, // strict's golden omits name -> render fails
  });
}

describe("@versioned-store/prompt-store", () => {
  test("resolves the code default (v0) and renders with vars", async () => {
    const s = makeStore();
    const pin = await s.resolvePin("greeting");
    assert.equal(pin.version, 0);
    assert.equal(s.renderPinned(pin, { name: "Ada" }), "Hello, Ada!");
  });

  test("promote gate refuses a version with an unknown placeholder", async () => {
    const s = makeStore();
    const v = await s.addPromptVersion("greeting", "Hi {{name}} from {{unknown}}");
    await assert.rejects(() => s.promote("greeting", v), /unknown placeholder/);
  });

  test("promote gate refuses a version that fails golden render (schema-required var missing from the golden)", async () => {
    const s = makeStore();
    const v = await s.addPromptVersion("strict", "Hi {{name}}");
    await assert.rejects(() => s.promote("strict", v), /eval gate failed/);
  });

  test("promote gate accepts a clean version, which then resolves + renders", async () => {
    const s = makeStore();
    const v = await s.addPromptVersion("greeting", "Hey {{name}}!");
    await s.promote("greeting", v);
    const pin = await s.resolvePin("greeting");
    assert.equal(pin.version, v);
    assert.equal(s.renderPinned(pin, { name: "Bo" }), "Hey Bo!");
  });

  test("render throws on an unbound placeholder", async () => {
    const s = makeStore();
    const pin = await s.resolvePin("greeting"); // "Hello, {{name}}!"
    assert.throws(() => s.renderPinned(pin, {}), /invalid vars|unbound placeholder/);
  });
});
