import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { createInMemoryBackend, VersionedStoreError, type StoreEvent } from "@versioned-store/core";
import { PromptNotFoundError, PromptRenderError, createPromptStore } from "./index.js";

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

describe("alpha.4 facade passthrough: onEvent, revertToCodeDefault, note + refs", () => {
  function makeStoreWith(onEvent?: (e: StoreEvent) => void) {
    const backend = createInMemoryBackend();
    const store = createPromptStore({
      backend,
      defaults: { greeting: { text: "Hello, {{name}}!" } },
      varSchemas: { greeting: z.object({ name: z.string() }) },
      goldens: { greeting: [{ name: "World" }] },
      onEvent,
    });
    return { store, backend };
  }

  test("onEvent sink reaches the core and fires on promote-accepted, carrying note + refs", async () => {
    const events: StoreEvent[] = [];
    const { store } = makeStoreWith((e) => events.push(e));
    const v = await store.addPromptVersion("greeting", "Hi {{name}}!");
    await store.promote("greeting", v, { by: "op", note: "why promoted", refs: { exp: "A" } });
    const accepted = events.find((e) => e.type === "promote-accepted");
    assert.ok(accepted, "the sink received a promote-accepted event");
    if (accepted.type === "promote-accepted") {
      assert.equal(accepted.note, "why promoted");
      assert.deepEqual(accepted.refs, { exp: "A" });
    }
  });

  test("note + refs persist on the label through the gated facade promote", async () => {
    const { store, backend } = makeStoreWith();
    const v = await store.addPromptVersion("greeting", "Hi {{name}}!");
    await store.promote("greeting", v, { note: "shipped", refs: { ticket: 7 } });
    const label = await backend.getLabel("greeting", "active");
    assert.equal(label?.note, "shipped");
    assert.deepEqual(label?.refs, { ticket: 7 });
  });

  test("revertToCodeDefault returns the key to its in-code default (ungated)", async () => {
    const { store } = makeStoreWith();
    const v = await store.addPromptVersion("greeting", "Edited {{name}}");
    await store.promote("greeting", v);
    assert.equal((await store.resolvePin("greeting")).version, v);
    const rv = await store.revertToCodeDefault("greeting", { by: "op" });
    assert.ok(rv > v, "adds and promotes a new version, not the sentinel");
    assert.equal(store.renderPinned(await store.resolvePin("greeting"), { name: "X" }), "Hello, X!");
  });
});

describe("error taxonomy", () => {
  // A consumer catches the library with one `catch (e instanceof VersionedStoreError)`. That only works if
  // the domain packages throw into the core's taxonomy too, so these are not bare Errors.
  test("render and not-found errors extend the core's VersionedStoreError", async () => {
    const store = makeStore();
    const pin = await store.resolvePin("greeting");

    assert.throws(() => store.renderPinned(pin, {}), (err: unknown) => {
      assert.ok(err instanceof PromptRenderError, "expected a PromptRenderError");
      assert.ok(err instanceof VersionedStoreError, "a blanket catch on the core's base must cover it");
      assert.equal((err as PromptRenderError).key, "greeting");
      return true;
    });

    await assert.rejects(() => store.resolvePin("no-such-key"), (err: unknown) => {
      assert.ok(err instanceof PromptNotFoundError);
      assert.ok(err instanceof VersionedStoreError);
      return true;
    });
  });
});

describe("var-schema detection is structural (survives a duplicated zod) — TD-VS-06", () => {
  // A schema object shaped like a ZodObject but NOT an instance of THIS package's z.ZodObject: exactly what
  // a consumer with a duplicated/version-split zod would pass. The old `instanceof z.ZodObject` returned []
  // for it, silently disabling the promote-gate's unknown-placeholder check. The structural check enumerates
  // its fields by `.shape`, so the gate works regardless of which zod copy built the schema.
  const foreignSchema = {
    shape: { name: {}, tone: {} },
    safeParse: (v: unknown) => ({ success: true as const, data: v }),
  } as unknown as z.ZodType;

  function makeForeignStore() {
    return createPromptStore({
      backend: createInMemoryBackend(),
      defaults: { greet: { text: "Hi {{name}}" } },
      varSchemas: { greet: foreignSchema },
    });
  }

  test("knownPlaceholders enumerates a foreign-zod object schema's fields", () => {
    assert.deepEqual(makeForeignStore().knownPlaceholders("greet").sort(), ["name", "tone"]);
  });

  test("unknownPlaceholders flags a placeholder outside a foreign-zod schema", () => {
    assert.deepEqual(makeForeignStore().unknownPlaceholders("greet", "Hi {{name}} {{bogus}}"), ["bogus"]);
  });

  test("a scalar (non-object) schema is still treated as no-shape, not a crash", () => {
    const store = createPromptStore({
      backend: createInMemoryBackend(),
      defaults: { s: { text: "x" } },
      varSchemas: { s: z.string() as unknown as z.ZodType },
    });
    assert.deepEqual(store.knownPlaceholders("s"), []);
    assert.deepEqual(store.unknownPlaceholders("s", "x {{y}}"), []);
  });
});
