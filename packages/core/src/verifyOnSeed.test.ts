// verify-on-seed: seed/sync promote the code default to the ACTIVE version, so an unsound default (one that
// cannot pass its own gate) would be made active unvalidated. When a gate is supplied, seed/sync refuse it
// instead: skip the promote, report it, never throw. The unsound default is then served only via the fallback
// path, which the caller guards at boot with checkDefaults.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryBackend } from "./backends/memory.js";
import { createVersionedStore, type DefaultsGate } from "./versionedStore.js";
import type { VersionedStoreBackend } from "./backend.js";

function makeStore(defaults: Record<string, string>, backend: VersionedStoreBackend = createInMemoryBackend()) {
  return createVersionedStore<string>(
    { domain: "test", defaults, hash: (v) => v, toDoc: (v) => ({ v }), fromDoc: (d) => (typeof d.v === "string" ? d.v : null) },
    backend,
  );
}

const noBadGate: DefaultsGate<string> = (_k, v) => ({
  passed: !v.includes("BAD"),
  failures: v.includes("BAD") ? ["contains BAD"] : [],
});

describe("verify-on-seed", () => {
  it("without a gate, every default is seeded (backward compatible)", async () => {
    const store = makeStore({ a: "fine", b: "this is BAD" });
    const res = await store.seedDefaults();
    assert.deepEqual(
      res.map((r) => r.seeded),
      [true, true],
    );
    assert.equal((await store.resolve("b"))?.version, 1); // the unsound one IS active, ungated (the old behavior)
  });

  it("seedDefaults refuses an unsound default and seeds the sound one", async () => {
    const store = makeStore({ good: "fine", bad: "this is BAD" });
    const res = await store.seedDefaults({ gate: noBadGate });

    assert.equal(res.find((r) => r.key === "good")?.seeded, true);
    const bad = res.find((r) => r.key === "bad");
    assert.equal(bad?.seeded, false);
    assert.equal(bad?.refused, true);
    assert.deepEqual(bad?.failures, ["contains BAD"]);

    assert.equal((await store.resolve("good"))?.version, 1); // sound default promoted to v1
    assert.equal(await store.getActiveVersion("bad"), null); // unsound default NOT promoted
    // it is still SERVED via the fallback, at the sentinel v0 — the caller's checkDefaults guards that path
    assert.equal((await store.resolve("bad"))?.version, 0);
    assert.equal((await store.resolve("bad"))?.value, "this is BAD");
  });

  it("seedDefaults never throws on an unsound default (a bad default cannot halt the seed)", async () => {
    const store = makeStore({ bad: "BAD", also: "BAD too", fine: "ok" });
    await assert.doesNotReject(() => store.seedDefaults({ gate: noBadGate }));
    assert.equal((await store.resolve("fine"))?.version, 1);
  });

  it("syncDefaults refuses an unsound default it would otherwise seed", async () => {
    const store = makeStore({ good: "fine", bad: "this is BAD" });
    const res = await store.syncDefaults({ gate: noBadGate });
    assert.equal(res.find((r) => r.key === "good")?.action, "seeded");
    const bad = res.find((r) => r.key === "bad");
    assert.equal(bad?.action, "refused");
    assert.deepEqual(bad?.failures, ["contains BAD"]);
    assert.equal(await store.getActiveVersion("bad"), null);
  });

  it("syncDefaults refuses an unsound UPDATE, leaving the current active version in place", async () => {
    const backend = createInMemoryBackend();
    await makeStore({ k: "good" }, backend).seedDefaults(); // k -> v1 "good", active

    // the code default later "changes" to an unsound value; sync must not promote it over the good active one
    const res = await makeStore({ k: "now BAD" }, backend).syncDefaults({ gate: noBadGate });
    assert.equal(res.find((r) => r.key === "k")?.action, "refused");
    assert.equal((await makeStore({ k: "now BAD" }, backend).getActiveVersion("k"))?.value, "good");
  });
});
