// Tests for M11 sealed content-addressed bundles (design 08 M11): seal/verify, tamper detection on versions
// AND labels, order-independent deterministic hashing, HMAC signing (right/wrong/absent secret), a
// cross-backend sealed round-trip, and refusal to import a tampered bundle.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { VersionedStoreBackend } from "./backend.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { createFileBackend } from "./backends/file.js";
import { exportSealed, importSealedBundle, sealBundle, verifyBundle, type SealedBundle } from "./bundle.js";
import { exportBackend, type StoreBundle } from "./migrate.js";

const sampleBundle: StoreBundle = {
  bundleVersion: 1,
  exportedLabels: ["active"],
  versions: [
    { key: "k", version: 1, sha256: "h1", createdAtIso: "t1", createdBy: "u", text: "one" },
    { key: "k", version: 2, sha256: "h2", createdAtIso: "t2", createdBy: "u", text: "two" },
  ],
  labels: [{ key: "k", label: "active", version: 2, promotedAtIso: "t2", promotedBy: "u" }],
};

async function seed(b: VersionedStoreBackend): Promise<void> {
  await b.init();
  for (const v of sampleBundle.versions) await b.insertVersion(v);
  for (const l of sampleBundle.labels) await b.upsertLabel(l);
}

describe("M11 sealed bundles", () => {
  test("seal then verify is valid", () => {
    assert.equal(verifyBundle(sealBundle(sampleBundle)).valid, true);
  });

  test("tampering with a version is detected", () => {
    const sealed = sealBundle(sampleBundle);
    const tampered: SealedBundle = { ...sealed, versions: sealed.versions.map((v) => (v.version === 1 ? { ...v, text: "HACKED" } : v)) };
    const r = verifyBundle(tampered);
    assert.equal(r.valid, false);
    assert.match(r.reason ?? "", /content hash mismatch/);
  });

  test("tampering with a label is detected", () => {
    const sealed = sealBundle(sampleBundle);
    const tampered: SealedBundle = { ...sealed, labels: [{ ...sealed.labels[0], version: 1 }] };
    assert.equal(verifyBundle(tampered).valid, false);
  });

  test("content hash is order-independent and deterministic", () => {
    const a = sealBundle(sampleBundle).contentHash;
    const reordered: StoreBundle = { ...sampleBundle, versions: [...sampleBundle.versions].reverse() };
    assert.equal(sealBundle(reordered).contentHash, a);
  });

  describe("signed (HMAC)", () => {
    const secret = "s3cr3t-signing-key";
    test("correct secret verifies; wrong secret fails", () => {
      const sealed = sealBundle(sampleBundle, { secret });
      assert.ok(sealed.signature);
      assert.equal(verifyBundle(sealed, { secret }).valid, true);
      assert.equal(verifyBundle(sealed, { secret: "wrong" }).valid, false);
    });
    test("a signed bundle still verifies on hash alone (no secret)", () => {
      assert.equal(verifyBundle(sealBundle(sampleBundle, { secret })).valid, true);
    });
    test("verifying an unsigned bundle WITH a secret fails", () => {
      const r = verifyBundle(sealBundle(sampleBundle), { secret });
      assert.equal(r.valid, false);
      assert.match(r.reason ?? "", /unsigned/);
    });
  });

  test("exportSealed -> importSealedBundle round-trips across backends and verifies", async () => {
    const src = createInMemoryBackend();
    await seed(src);
    const sealed = await exportSealed(src, { secret: "k1" });
    const dst = createFileBackend(mkdtempSync(join(tmpdir(), "vstore-bundle-")));
    await importSealedBundle(dst, sealed, { secret: "k1" });
    assert.equal((await dst.getVersion("k", 2))?.sha256, "h2");
    assert.equal((await dst.getLabel("k", "active"))?.version, 2);
    assert.equal(verifyBundle(sealBundle(await exportBackend(dst))).valid, true);
  });

  test("importSealedBundle refuses a tampered bundle (nothing is written)", async () => {
    const sealed = sealBundle(sampleBundle);
    const tampered: SealedBundle = { ...sealed, versions: sealed.versions.map((v) => ({ ...v, text: "x" })) };
    const dst = createInMemoryBackend();
    await assert.rejects(() => importSealedBundle(dst, tampered), /unverified bundle/);
    assert.deepEqual(await dst.distinctKeys(), []);
  });
});
