// Field-level encryption at rest: the store encrypts AFTER toDoc and decrypts BEFORE fromDoc, while the content
// hash and the eval-gate stay over PLAINTEXT. These tests hold the boundary honest: the backend sees ciphertext,
// resolve round-trips, dedup/change-detection are unperturbed, a subset leaves other fields queryable, and every
// unreadable case (wrong key, tampered, pre-cipher cleartext) fails CLOSED to the code default.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInMemoryBackend } from "./backends/memory.js";
import { createVersionedStore, type StoreCipher, type VersionedStoreConfig } from "./versionedStore.js";
import { createAesGcmCipher } from "./cipher.js";
import type { VersionedStoreBackend } from "./backend.js";

interface Secret {
  secret: string;
  label: string;
}

const KEY = Buffer.alloc(32, 3);
const WRONG_KEY = Buffer.alloc(32, 9);

function cfg(cipher?: StoreCipher, encryptedFields?: string[]): VersionedStoreConfig<Secret> {
  return {
    domain: "secret",
    defaults: { s1: { secret: "code-default-secret", label: "l0" } },
    // A real one-way hash (as the facades use): the stored sha256 is a plaintext DIGEST, so it must not leak
    // the plaintext even though it is computed over it. (A weak/identity "hash" would, which is a doc caveat.)
    hash: (v) => createHash("sha256").update(`${v.secret}|${v.label}`).digest("hex"),
    toDoc: (v) => ({ secret: v.secret, label: v.label }),
    fromDoc: (d) => (typeof d.secret === "string" && typeof d.label === "string" ? { secret: d.secret, label: d.label } : null),
    cipher,
    encryptedFields,
  };
}

function make(backend: VersionedStoreBackend, cipher?: StoreCipher, encryptedFields?: string[]) {
  return createVersionedStore<Secret>(cfg(cipher, encryptedFields), backend);
}

describe("field-level encryption at rest", () => {
  it("stores ciphertext in the backend (default = every field), but resolve round-trips to plaintext", async () => {
    const backend = createInMemoryBackend();
    const store = make(backend, createAesGcmCipher({ key: KEY }));
    const v = await store.addVersion("s1", { secret: "LIVEKIT_API_SECRET", label: "prod" });
    await store.promote("s1", v);

    const raw = await backend.getVersion("s1", v);
    assert.ok(typeof raw?.secret === "string" && (raw.secret as string).startsWith("vsc1:"), "secret is ciphertext at rest");
    assert.ok((raw!.label as string).startsWith("vsc1:"), "default encrypts every field, label included");
    assert.ok(!JSON.stringify(raw).includes("LIVEKIT_API_SECRET"), "plaintext secret is nowhere in the stored doc");

    const resolved = await store.resolve("s1");
    assert.deepEqual(resolved?.value, { secret: "LIVEKIT_API_SECRET", label: "prod" });
  });

  it("encryptedFields subset encrypts only the named field, leaving the rest queryable at rest", async () => {
    const backend = createInMemoryBackend();
    const store = make(backend, createAesGcmCipher({ key: KEY }), ["secret"]);
    const v = await store.addVersion("s1", { secret: "s3cr3t", label: "prod-us" });
    await store.promote("s1", v);

    const raw = await backend.getVersion("s1", v);
    assert.ok((raw!.secret as string).startsWith("vsc1:"), "secret is encrypted");
    assert.equal(raw!.label, "prod-us", "label stays cleartext, so it remains queryable");

    const resolved = await store.resolve("s1");
    assert.deepEqual(resolved?.value, { secret: "s3cr3t", label: "prod-us" });
  });

  it("keeps the content hash over plaintext: identical payloads hash-match despite randomized ciphertext", async () => {
    const backend = createInMemoryBackend();
    const store = make(backend, createAesGcmCipher({ key: KEY }));
    const v1 = await store.addVersion("s1", { secret: "x", label: "l" });
    const v2 = await store.addVersion("s1", { secret: "x", label: "l" });

    const r1 = await store.getVersion("s1", v1);
    const r2 = await store.getVersion("s1", v2);
    assert.equal(r1?.sha256, r2?.sha256, "same plaintext -> same hash");

    const raw1 = await backend.getVersion("s1", v1);
    const raw2 = await backend.getVersion("s1", v2);
    assert.notEqual(raw1?.secret, raw2?.secret, "randomized IV -> different ciphertext for the same plaintext");
  });

  it("syncDefaults still reports unchanged (change-detection is over the plaintext hash, not the ciphertext)", async () => {
    const backend = createInMemoryBackend();
    const store = make(backend, createAesGcmCipher({ key: KEY }));
    await store.seedDefaults();
    const res = await store.syncDefaults();
    assert.deepEqual(res, [{ key: "s1", action: "unchanged" }]);
  });

  it("fails closed on a wrong key: resolve serves the code default (v0), getVersion returns null", async () => {
    const backend = createInMemoryBackend();
    const writer = make(backend, createAesGcmCipher({ key: KEY }));
    const v = await writer.addVersion("s1", { secret: "real-secret", label: "l" });
    await writer.promote("s1", v);

    const reader = make(backend, createAesGcmCipher({ key: WRONG_KEY }));
    const resolved = await reader.resolve("s1");
    assert.equal(resolved?.version, 0, "code-default fallback, not the undecryptable ciphertext");
    assert.equal(resolved?.value.secret, "code-default-secret");
    assert.equal(await reader.getVersion("s1", v), null, "getVersion fails closed to null");
  });

  it("fails closed on a pre-cipher cleartext version once the cipher is enabled", async () => {
    const backend = createInMemoryBackend();
    const cleartext = make(backend); // no cipher: fields stored as plaintext strings
    const v = await cleartext.addVersion("s1", { secret: "cleartext-secret", label: "l" });
    await cleartext.promote("s1", v);

    const cipherOn = make(backend, createAesGcmCipher({ key: KEY }));
    const resolved = await cipherOn.resolve("s1");
    assert.equal(resolved?.version, 0, "the cleartext active version cannot be decrypted, so the code default serves");
  });

  it("fails closed when an encrypted field was stored as a non-string (a cleartext object field)", async () => {
    interface Cfg {
      name: string;
      opts: Record<string, unknown>;
    }
    const backend = createInMemoryBackend();
    const base: VersionedStoreConfig<Cfg> = {
      domain: "cfg",
      defaults: { k: { name: "n", opts: { fallback: true } } },
      hash: (v) => JSON.stringify(v),
      toDoc: (v) => ({ name: v.name, opts: v.opts }),
      fromDoc: (d) =>
        typeof d.name === "string" && d.opts !== null && typeof d.opts === "object"
          ? { name: d.name, opts: d.opts as Record<string, unknown> }
          : null,
    };
    const cleartext = createVersionedStore<Cfg>({ ...base, encryptedFields: ["opts"] }, backend);
    const v = await cleartext.addVersion("k", { name: "n", opts: { secret: 1 } });
    await cleartext.promote("k", v);

    // opts was stored as a cleartext OBJECT; a cipher-on reader sees a non-string in an encrypted field.
    const cipherOn = createVersionedStore<Cfg>({ ...base, encryptedFields: ["opts"], cipher: createAesGcmCipher({ key: KEY }) }, backend);
    const resolved = await cipherOn.resolve("k");
    assert.equal(resolved?.version, 0, "non-string encrypted field -> fail closed to the code default");
  });
});
