// M8 arbitrary-T proof (design 08 M8). The real M8 acceptance is "a non-prompt, non-scaffold payload versions
// through the library with its OWN toDoc/fromDoc/hash/onMissing + the eval-gate, and NO core changes were
// required." This proves exactly that with a third, genuinely different domain — FEATURE FLAGS (the canonical
// config-store payload, unlike prompts' text or scaffolds' build specs) — exercised end to end through the
// public API (createVersionedStore + the M6/M11/M12 helpers) with the core untouched. The literal adoption in
// a second repo (BEPA) is cross-repo work; this is the library-side extensibility guarantee, testable here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { exportBackend } from "./migrate.js";
import { sealBundle, verifyBundle } from "./bundle.js";
import { evaluateCanary, promoteCanary, resolveWeighted } from "./canary.js";

interface FeatureFlag {
  enabled: boolean;
  rolloutPercent: number;
  description?: string;
}

// The domain's OWN config: nests the payload under `flag` (a different on-disk shape than prompts/scaffolds),
// its own content hash, its own validate (range check), and onMissing = code-default-is-first-class (a missing
// flag legitimately falls back to the in-code default — off), unlike prompts which alarm on a miss.
const flagCfg: VersionedStoreConfig<FeatureFlag> = {
  domain: "flags",
  defaults: { "new-checkout": { enabled: false, rolloutPercent: 0, description: "code default: off" } },
  codeDefaultIsFirstClass: true,
  hash: (f) => JSON.stringify([f.enabled, f.rolloutPercent, f.description ?? ""]),
  toDoc: (f) => ({ flag: f }),
  fromDoc: (d) => {
    const f = d.flag as FeatureFlag | undefined;
    return f && typeof f.enabled === "boolean" && typeof f.rolloutPercent === "number" ? f : null;
  },
  validate: (f) => {
    if (f.rolloutPercent < 0 || f.rolloutPercent > 100) throw new Error("rolloutPercent must be 0..100");
    return f;
  },
};

// The domain's deterministic eval-gate (tier 1): an enabled flag at 0% rollout is a silent no-op — refuse it.
const flagGate = (f: FeatureFlag) => ({
  passed: !(f.enabled && f.rolloutPercent === 0),
  failures: f.enabled && f.rolloutPercent === 0 ? ["a flag enabled at 0% rollout is a silent no-op"] : [],
});

describe("M8 arbitrary-T: a feature-flag domain, no core changes", () => {
  test("code-default fallback, add/validate, and the eval-gate on promote all work for the new T", async () => {
    const s = createVersionedStore(flagCfg, createInMemoryBackend());

    // unseeded key -> the v0 sentinel code default (onMissing first-class)
    const def = await s.resolve("new-checkout");
    assert.equal(def?.version, 0);
    assert.equal(def?.value.enabled, false);

    // validate rejects an out-of-range rollout at add time
    await assert.rejects(() => s.addVersion("new-checkout", { enabled: true, rolloutPercent: 150 }));

    await s.addVersion("new-checkout", { enabled: false, rolloutPercent: 0 }); // v1
    await s.addVersion("new-checkout", { enabled: true, rolloutPercent: 25 }); // v2
    await s.addVersion("new-checkout", { enabled: true, rolloutPercent: 0 }); // v3 (valid range, but a no-op)

    // the eval-gate refuses the no-op flag at promote, accepts the good one
    await assert.rejects(() => s.promote("new-checkout", 3, { gate: flagGate }));
    await s.promote("new-checkout", 2, { gate: flagGate });
    assert.equal((await s.resolve("new-checkout"))?.value.rolloutPercent, 25);
  });

  test("canary auto-rollback + a sealed portable bundle work for the new T", async () => {
    const backend = createInMemoryBackend();
    const s = createVersionedStore(flagCfg, backend);
    await s.addVersion("f", { enabled: true, rolloutPercent: 10 }); // v1
    await s.addVersion("f", { enabled: true, rolloutPercent: 50 }); // v2
    await s.promote("f", 1);
    await promoteCanary(s, "f", 2);

    // the canary (50%) is served to the canary fraction
    assert.equal((await resolveWeighted(s, "f", { canaryFraction: 1, roll: 0 }))?.value.rolloutPercent, 50);

    // a running gate deems 50% too aggressive -> auto-rollback to the last-known-good (v1)
    const ev = await evaluateCanary(
      s,
      "f",
      (f: FeatureFlag) => ({ passed: f.rolloutPercent <= 25, failures: f.rolloutPercent > 25 ? ["rollout too aggressive"] : [] }),
      { domain: "flags" },
    );
    assert.equal(ev.rolledBack, true);
    assert.equal(ev.rolledBackTo, 1);

    // the whole flag store seals into a verifiable portable bundle (arbitrary T end to end)
    const sealed = sealBundle(await exportBackend(backend), { secret: "flag-key" });
    assert.equal(verifyBundle(sealed, { secret: "flag-key" }).valid, true);
  });
});
