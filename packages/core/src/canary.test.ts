// Tests for M12 shadow/canary + gate-driven auto-rollback (design 08 M12). Deterministic: resolveWeighted's
// split is driven by an injected `roll`, and the auto-rollback is driven by a stub gate result.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createVersionedStore, type VersionedStoreConfig, type VersionedStore } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { getStoreEventCounts, resetStoreEventCounts } from "./events.js";
import { CANARY_LABEL, evaluateCanary, promoteCanary, promoteShadow, resolveShadow, resolveWeighted } from "./canary.js";

const cfg: VersionedStoreConfig<{ text: string }> = {
  domain: "cnry",
  defaults: {},
  hash: (v) => v.text,
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
};

async function setup(): Promise<VersionedStore<{ text: string }>> {
  const s = createVersionedStore(cfg, createInMemoryBackend());
  await s.addVersion("k", { text: "v1-active" }); // v1
  await s.addVersion("k", { text: "v2-canary" }); // v2
  await s.promote("k", 1); // active -> v1 (the last-known-good)
  return s;
}

describe("M12 shadow/canary + auto-rollback", () => {
  beforeEach(() => resetStoreEventCounts());

  test("resolveWeighted serves canary below the fraction, active above", async () => {
    const s = await setup();
    await promoteCanary(s, "k", 2);
    assert.equal((await resolveWeighted(s, "k", { canaryFraction: 0.5, roll: 0.1 }))?.value.text, "v2-canary");
    assert.equal((await resolveWeighted(s, "k", { canaryFraction: 0.5, roll: 0.9 }))?.value.text, "v1-active");
  });

  test("resolveWeighted falls back to active when no canary is set", async () => {
    const s = await setup();
    assert.equal((await resolveWeighted(s, "k", { canaryFraction: 1.0, roll: 0.0 }))?.value.text, "v1-active");
  });

  test("resolveShadow returns active + shadow together", async () => {
    const s = await setup();
    await promoteShadow(s, "k", 2);
    const { active, shadow } = await resolveShadow(s, "k");
    assert.equal(active?.value.text, "v1-active");
    assert.equal(shadow?.value.text, "v2-canary");
  });

  test("evaluateCanary leaves a passing canary in place", async () => {
    const s = await setup();
    await promoteCanary(s, "k", 2);
    const ev = await evaluateCanary(s, "k", () => ({ passed: true, failures: [] }));
    assert.equal(ev.gatePassed, true);
    assert.equal(ev.rolledBack, false);
    assert.equal((await s.getActiveVersion("k", CANARY_LABEL))?.version, 2);
  });

  test("evaluateCanary auto-rolls-back a failing canary to last-known-good and alarms", async () => {
    const s = await setup();
    await promoteCanary(s, "k", 2);
    const ev = await evaluateCanary(s, "k", () => ({ passed: false, failures: ["bad output"] }), { domain: "cnry" });
    assert.equal(ev.gatePassed, false);
    assert.equal(ev.rolledBack, true);
    assert.equal(ev.rolledBackTo, 1);
    assert.deepEqual(ev.failures, ["bad output"]);
    assert.equal((await s.getActiveVersion("k", CANARY_LABEL))?.version, 1); // demoted to the active version
    assert.equal(getStoreEventCounts()["promote-refused:cnry"], 1); // alarmed
  });

  test("evaluateCanary is a no-op when no canary is set", async () => {
    const s = await setup();
    const ev = await evaluateCanary(s, "k", () => ({ passed: false, failures: ["x"] }));
    assert.equal(ev.gatePassed, null);
    assert.equal(ev.rolledBack, false);
    assert.equal(ev.canaryVersion, null);
  });
});
