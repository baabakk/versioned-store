// Tests for the M3 store-event surface (design 08 M3): the versioned event schema, the counter, and the
// core's promote emitting gate-outcome / promote-accepted / promote-refused. Each test resets the
// module-global counter first (node's test runner isolates files in separate processes, so cross-file
// counts do not leak; beforeEach isolates the tests within this file).

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { emitStoreEvent, getStoreEventCounts, recordFallback, resetStoreEventCounts, STORE_EVENT_SCHEMA_VERSION } from "./events.js";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";

const cfg: VersionedStoreConfig<{ text: string }> = {
  domain: "ev",
  defaults: {},
  hash: (v) => v.text,
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
};

describe("store events (design 08 M3)", () => {
  beforeEach(() => resetStoreEventCounts());

  test("schema version is exported and pinned at 1", () => {
    assert.equal(STORE_EVENT_SCHEMA_VERSION, 1);
  });

  test("emitStoreEvent increments the per-(type,domain) counter", () => {
    emitStoreEvent({ schemaVersion: 1, type: "promote-accepted", domain: "d", key: "k", version: 1, label: "active", by: "u" });
    emitStoreEvent({ schemaVersion: 1, type: "promote-accepted", domain: "d", key: "k2", version: 2, label: "active", by: "u" });
    assert.equal(getStoreEventCounts()["promote-accepted:d"], 2);
  });

  test("recordFallback feeds the same event/counter surface", () => {
    recordFallback("d", "k", "label-missing");
    assert.equal(getStoreEventCounts()["fallback:d"], 1);
  });

  test("a refused promote emits promote-refused + gate-outcome, not promote-accepted", async () => {
    const s = createVersionedStore(cfg, createInMemoryBackend());
    await s.addVersion("k", { text: "bad" });
    await assert.rejects(() => s.promote("k", 1, { gate: () => ({ passed: false, failures: ["nope"] }) }));
    const c = getStoreEventCounts();
    assert.equal(c["promote-refused:ev"], 1);
    assert.equal(c["gate-outcome:ev"], 1);
    assert.equal(c["promote-accepted:ev"], undefined);
  });

  test("an accepted promote emits promote-accepted + gate-outcome(passed)", async () => {
    const s = createVersionedStore(cfg, createInMemoryBackend());
    await s.addVersion("k", { text: "good" });
    await s.promote("k", 1, { gate: () => ({ passed: true, failures: [] }) });
    const c = getStoreEventCounts();
    assert.equal(c["promote-accepted:ev"], 1);
    assert.equal(c["gate-outcome:ev"], 1);
  });

  test("a gate-less promote emits promote-accepted and no gate-outcome", async () => {
    const s = createVersionedStore(cfg, createInMemoryBackend());
    await s.addVersion("k", { text: "x" });
    await s.promote("k", 1);
    const c = getStoreEventCounts();
    assert.equal(c["promote-accepted:ev"], 1);
    assert.equal(c["gate-outcome:ev"], undefined);
  });
});
