// The built-in AES-256-GCM StoreCipher: round-trip, tamper detection, wrong-key/AAD failure, and the
// randomized-IV property that makes it safe to pair with a plaintext content hash (no dedup leak).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAesGcmCipher } from "./cipher.js";

const KEY = Buffer.alloc(32, 7);

describe("createAesGcmCipher", () => {
  it("round-trips plaintext", () => {
    const c = createAesGcmCipher({ key: KEY });
    const ct = c.encrypt("secret-value") as string;
    assert.equal(c.decrypt(ct), "secret-value");
  });

  it("marks its output and does not leak the plaintext", () => {
    const c = createAesGcmCipher({ key: KEY });
    const ct = c.encrypt("LIVEKIT_API_SECRET") as string;
    assert.match(ct, /^vsc1:/);
    assert.ok(!ct.includes("LIVEKIT_API_SECRET"));
  });

  it("draws a fresh IV: the same plaintext yields different ciphertext, and both decrypt", () => {
    const c = createAesGcmCipher({ key: KEY });
    const a = c.encrypt("same") as string;
    const b = c.encrypt("same") as string;
    assert.notEqual(a, b);
    assert.equal(c.decrypt(a), "same");
    assert.equal(c.decrypt(b), "same");
  });

  it("rejects a wrong key (the auth tag fails)", () => {
    const ct = createAesGcmCipher({ key: KEY }).encrypt("x") as string;
    const wrong = createAesGcmCipher({ key: Buffer.alloc(32, 9) });
    assert.throws(() => wrong.decrypt(ct));
  });

  it("detects tampering: a flipped byte fails authentication", () => {
    const c = createAesGcmCipher({ key: KEY });
    const ct = c.encrypt("x") as string;
    const body = ct.slice("vsc1:".length);
    const tampered = "vsc1:" + (body[0] === "A" ? "B" : "A") + body.slice(1);
    assert.throws(() => c.decrypt(tampered));
  });

  it("binds AAD: decrypting with a different AAD fails", () => {
    const ct = createAesGcmCipher({ key: KEY, aad: "tenant-1" }).encrypt("x") as string;
    assert.equal(createAesGcmCipher({ key: KEY, aad: "tenant-1" }).decrypt(ct), "x");
    assert.throws(() => createAesGcmCipher({ key: KEY, aad: "tenant-2" }).decrypt(ct));
  });

  it("rejects a non-vsc1 string (a pre-cipher cleartext value)", () => {
    assert.throws(() => createAesGcmCipher({ key: KEY }).decrypt("just plaintext"), /not a vsc1/);
  });

  it("rejects a wrong-length key at construction", () => {
    assert.throws(() => createAesGcmCipher({ key: Buffer.alloc(16, 1) }), /32 bytes/);
  });

  it("accepts a base64 key string", () => {
    const c = createAesGcmCipher({ key: KEY.toString("base64") });
    assert.equal(c.decrypt(c.encrypt("y") as string), "y");
  });
});
