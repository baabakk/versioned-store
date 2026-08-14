// Tests for the alpha.3 promote-path additions: the onEvent sink (issue #4), note + refs on promote
// (Appendix A.3/A.4), and revertToCodeDefault + the promote(key,0) kill-switch error (Appendix A.6).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { KillSwitchNotSupportedError, VersionedStoreError } from "./errors.js";
import type { StoreEvent } from "./events.js";

type P = { text: string };

function makeStore(overrides: Partial<VersionedStoreConfig<P>> = {}) {
  const cfg: VersionedStoreConfig<P> = {
    domain: "t",
    defaults: { greeting: { text: "hello" } },
    hash: (v) => v.text,
    toDoc: (v) => ({ text: v.text }),
    fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
    ...overrides,
  };
  const backend = createInMemoryBackend();
  return { store: createVersionedStore<P>(cfg, backend), backend };
}

describe("onEvent sink (issue #4)", () => {
  test("fires on promote-accepted, carrying note + refs", async () => {
    const events: StoreEvent[] = [];
    const { store } = makeStore({ onEvent: (e) => events.push(e) });
    await store.ensureIndexes();
    const v = await store.addVersion("greeting", { text: "hi" });
    await store.promote("greeting", v, { by: "op", note: "why promoted", refs: { exp: "A" } });
    const accepted = events.find((e) => e.type === "promote-accepted");
    assert.ok(accepted, "a promote-accepted event reached the sink");
    if (accepted.type === "promote-accepted") {
      assert.equal(accepted.note, "why promoted");
      assert.deepEqual(accepted.refs, { exp: "A" });
    }
  });

  test("a throwing sink is swallowed and does not break the promote", async () => {
    const { store } = makeStore({ onEvent: () => { throw new Error("sink down"); } });
    await store.ensureIndexes();
    const v = await store.addVersion("greeting", { text: "hi" });
    await store.promote("greeting", v); // must not throw
    assert.equal((await store.resolve("greeting"))?.value.text, "hi");
  });

  test("fires on a fallback event too (resolve with no active label)", async () => {
    const events: StoreEvent[] = [];
    const { store } = makeStore({ onEvent: (e) => events.push(e) });
    await store.ensureIndexes();
    assert.equal((await store.resolve("greeting"))?.value.text, "hello"); // falls back to the code default
    assert.ok(events.some((e) => e.type === "fallback"), "a fallback event reached the sink");
  });
});

describe("promote persists note + refs on the label (A.3/A.4)", () => {
  test("retrievable via the injected backend's getLabel", async () => {
    const { store, backend } = makeStore();
    await store.ensureIndexes();
    const v = await store.addVersion("greeting", { text: "hi" });
    await store.promote("greeting", v, { note: "shipped", refs: { ticket: 42 } });
    const label = await backend.getLabel("greeting", "active");
    assert.equal(label?.note, "shipped");
    assert.deepEqual(label?.refs, { ticket: 42 });
  });
});

describe("revertToCodeDefault (A.6)", () => {
  test("returns a key to its in-code default and reports the new version, preserving history", async () => {
    const { store } = makeStore();
    await store.ensureIndexes();
    const v1 = await store.addVersion("greeting", { text: "edited" });
    await store.promote("greeting", v1);
    assert.equal((await store.resolve("greeting"))?.value.text, "edited");

    const rv = await store.revertToCodeDefault("greeting", { by: "op" });
    assert.ok(rv > v1, "adds and promotes a new version, not the sentinel");
    assert.equal((await store.resolve("greeting"))?.value.text, "hello", "resolves to the code default");
    assert.ok((await store.listVersions("greeting")).some((x) => x.version === v1), "prior version is retained");
  });

  test("throws when the key has no in-code default", async () => {
    const { store } = makeStore();
    await store.ensureIndexes();
    await assert.rejects(() => store.revertToCodeDefault("unknown"), (e) => e instanceof VersionedStoreError);
  });
});

describe("promote(key, 0) (A.6 UX)", () => {
  test("throws KillSwitchNotSupportedError, not the generic VersionNotFoundError", async () => {
    const { store } = makeStore();
    await store.ensureIndexes();
    await assert.rejects(
      () => store.promote("greeting", 0),
      (e) => e instanceof KillSwitchNotSupportedError && e instanceof VersionedStoreError,
    );
  });
});
