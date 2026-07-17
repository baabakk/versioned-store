// The versioned-store conformance suite (design 08 M1/M13/M14), EXPORTED so any backend — the built-in five
// or a third-party adapter — can be certified with `runConformance("MyBackend", () => makeMyBackend())`. It
// exercises the storage contract directly (Part A) AND the core's policy over the backend (Part B, including
// the concurrent-CAS test). If it is green, the adapter honours immutability, CAS, version ordering, and
// labels. Importing this module registers nothing; the describe/test calls run only when runConformance is
// CALLED, so it is safe to ship in the package's build.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BackendConflictError, type VersionedStoreBackend } from "./backend.js";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";

interface Payload {
  text: string;
}

const coreCfg: VersionedStoreConfig<Payload> = {
  domain: "conformance",
  defaults: { greeting: { text: "hi" } },
  codeDefaultIsFirstClass: true, // keep unseeded-fallback logs at debug so the suite output stays quiet
  hash: (v) => `sha:${v.text}`,
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
};

/**
 * Run the full conformance suite (storage contract + core policy) against a backend factory. Call once per
 * backend; the factory must produce a FRESH, isolated backend each call. A third party certifies its adapter
 * by importing this and calling `runConformance("MyBackend", () => makeMyBackend())` under `node --test`.
 */
export function runConformance(name: string, make: () => VersionedStoreBackend): void {
  // Part A — the storage contract, exercised directly against the backend.
  describe(`backend contract: ${name}`, () => {
    test("empty state", async () => {
      const b = make();
      await b.init();
      assert.equal(await b.maxVersion("k"), null);
      assert.equal(await b.getVersion("k", 1), null);
      assert.deepEqual(await b.listVersionsDesc("k"), []);
      assert.deepEqual(await b.distinctKeys(), []);
      assert.equal(await b.getLabel("k", "active"), null);
    });

    test("insert + read back with arbitrary payload", async () => {
      const b = make();
      await b.init();
      await b.insertVersion({ key: "k", version: 1, sha256: "h1", createdAtIso: "t1", createdBy: "u", note: "n", extra: { a: 1, deep: [1, 2] } });
      const d = await b.getVersion("k", 1);
      assert.equal(d?.sha256, "h1");
      assert.equal(d?.note, "n");
      assert.deepEqual(d?.extra, { a: 1, deep: [1, 2] });
    });

    test("immutability: duplicate (key,version) throws BackendConflictError, original untouched", async () => {
      const b = make();
      await b.init();
      await b.insertVersion({ key: "k", version: 1, sha256: "h1", createdAtIso: "t1", createdBy: "u" });
      await assert.rejects(
        () => b.insertVersion({ key: "k", version: 1, sha256: "hX", createdAtIso: "tX", createdBy: "u" }),
        (e) => e instanceof BackendConflictError && e.key === "k" && e.version === 1,
      );
      assert.equal((await b.getVersion("k", 1))?.sha256, "h1");
    });

    test("maxVersion + listVersionsDesc order", async () => {
      const b = make();
      await b.init();
      for (const v of [1, 2, 3]) await b.insertVersion({ key: "k", version: v, sha256: `h${v}`, createdAtIso: `t${v}`, createdBy: "u" });
      assert.equal(await b.maxVersion("k"), 3);
      assert.deepEqual((await b.listVersionsDesc("k")).map((d) => d.version), [3, 2, 1]);
    });

    test("distinctKeys ascending-sorted", async () => {
      const b = make();
      await b.init();
      for (const k of ["p", "a", "m"]) await b.insertVersion({ key: k, version: 1, sha256: "h", createdAtIso: "t", createdBy: "u" });
      assert.deepEqual(await b.distinctKeys(), ["a", "m", "p"]);
    });

    test("labels: upsert is movable", async () => {
      const b = make();
      await b.init();
      assert.equal(await b.getLabel("k", "active"), null);
      await b.upsertLabel({ key: "k", label: "active", version: 1, promotedAtIso: "t1", promotedBy: "u" });
      assert.equal((await b.getLabel("k", "active"))?.version, 1);
      await b.upsertLabel({ key: "k", label: "active", version: 2, promotedAtIso: "t2", promotedBy: "u" });
      assert.equal((await b.getLabel("k", "active"))?.version, 2);
    });

    test("init is idempotent (re-run after data exists does not wipe or throw)", async () => {
      const b = make();
      await b.init();
      await b.init();
      await b.insertVersion({ key: "k", version: 1, sha256: "h", createdAtIso: "t", createdBy: "u" });
      await b.init();
      assert.equal(await b.maxVersion("k"), 1);
    });
  });

  // Part B — the core's policy over the backend (createVersionedStore with the backend injected).
  describe(`core over ${name}`, () => {
    test("addVersion -> getVersion -> promote -> resolve", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      await s.ensureIndexes();
      assert.equal(await s.addVersion("k", { text: "one" }), 1);
      assert.equal(await s.addVersion("k", { text: "two" }), 2);
      assert.equal((await s.getVersion("k", 1))?.value.text, "one");
      assert.equal(await s.resolve("k"), null); // no label + no code default for "k"
      await s.promote("k", 2);
      assert.equal((await s.resolve("k"))?.value.text, "two");
      assert.equal((await s.resolve("k"))?.version, 2);
    });

    test("resolve falls back to the code default (sentinel v0) when unseeded", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      const r = await s.resolve("greeting");
      assert.equal(r?.version, 0);
      assert.equal(r?.value.text, "hi");
    });

    test("promote gate blocks a failing version, passes a good one", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      await s.addVersion("k", { text: "bad" });
      await assert.rejects(() => s.promote("k", 1, { gate: (v) => ({ passed: v.text !== "bad", failures: ["is bad"] }) }));
      await s.addVersion("k", { text: "good" });
      await s.promote("k", 2, { gate: (v) => ({ passed: v.text === "good", failures: [] }) });
      assert.equal((await s.getActiveVersion("k"))?.value.text, "good");
    });

    test("seedDefaults is idempotent", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      assert.deepEqual(await s.seedDefaults(), [{ key: "greeting", seeded: true }]);
      assert.deepEqual(await s.seedDefaults(), [{ key: "greeting", seeded: false }]);
      assert.equal((await s.resolve("greeting"))?.version, 1); // seeded now -> v1, not the v0 sentinel
    });

    test("syncDefaults seeds then no-ops", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      assert.deepEqual(await s.syncDefaults(), [{ key: "greeting", action: "seeded" }]);
      assert.deepEqual(await s.syncDefaults(), [{ key: "greeting", action: "unchanged" }]);
    });

    test("concurrent addVersion: CAS retry yields distinct sequential versions (no lost update)", async () => {
      const s = createVersionedStore<Payload>(coreCfg, make());
      const N = 4; // < MAX_CAS_ATTEMPTS(5): the worst-case writer needs at most N attempts, leaving margin
      const results = await Promise.all(Array.from({ length: N }, (_, i) => s.addVersion("hot", { text: `v${i}` })));
      assert.deepEqual([...results].sort((a, b) => a - b), [1, 2, 3, 4]); // every call won a unique version
      assert.deepEqual((await s.listVersions("hot")).map((x) => x.version), [4, 3, 2, 1]);
    });
  });
}
