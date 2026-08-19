// A ready-made StoreCipher: AES-256-GCM over node:crypto, zero npm dependencies. Opt-in via the
// `@versioned-store/core/cipher` subpath, so the main entry stays free of an opinionated cipher and a consumer
// who wires a KMS-backed StoreCipher never loads this.
//
// Wire it as `createVersionedStore({ ..., cipher: createAesGcmCipher({ key }), encryptedFields: [...] })`. The
// store encrypts AFTER toDoc and decrypts BEFORE fromDoc; the content hash and the eval-gate stay over the
// plaintext, so dedup and gating are unaffected. Because each encrypt draws a fresh random IV, the SAME
// plaintext yields DIFFERENT ciphertext every time, and that is safe here precisely because the store never
// hashes or dedups the ciphertext.
//
// Threat model: this protects the backend AT REST. It does NOT protect a live compromised process (which holds
// the key and the store's decrypted resolve cache). Key storage, leasing, and rotation stay the host's job
// (non-goal: not a secrets manager). Rotation note: versions are immutable and content-addressed, so there is
// no re-encrypt-on-read; rotate by re-publishing under a new key and retiring the old ciphertext.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoreCipher } from "./versionedStore.js";

/** Format tag: versioned-store cipher, format 1 (AES-256-GCM, 12-byte IV, 16-byte tag, base64url of iv|tag|ct). */
const MARKER = "vsc1";
const IV_BYTES = 12; // 96-bit nonce, the AES-GCM standard
const TAG_BYTES = 16; // 128-bit GCM auth tag
const KEY_BYTES = 32; // AES-256

export interface AesGcmCipherOptions {
  /**
   * The 32-byte AES-256 key. Pass a 32-byte `Buffer`, or its base64 encoding as a string. The host owns key
   * storage and rotation; this cipher only uses the key. A key of the wrong length is rejected at construction.
   */
  key: Buffer | string;
  /**
   * Optional additional authenticated data: bound to the ciphertext's integrity but not encrypted. When set,
   * the SAME value must be present to decrypt (a mismatch fails authentication). Useful to bind a record to its
   * context (e.g. a tenant id) so a ciphertext cannot be replayed into another context.
   */
  aad?: Buffer | string;
}

function coerceKey(key: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(`[cipher] key must be ${KEY_BYTES} bytes (got ${buf.length}); pass a 32-byte Buffer or its base64`);
  }
  return buf;
}

/**
 * Build an AES-256-GCM `StoreCipher`. Synchronous (node:crypto's block cipher is sync), which satisfies the
 * `string | Promise<string>` contract. `encrypt` returns `vsc1:<base64url(iv | tag | ciphertext)>`; `decrypt`
 * requires that exact marker and verifies the GCM tag, throwing on any tamper, wrong key, or wrong AAD.
 */
export function createAesGcmCipher(opts: AesGcmCipherOptions): StoreCipher {
  const key = coerceKey(opts.key);
  const aad = opts.aad === undefined ? undefined : Buffer.isBuffer(opts.aad) ? opts.aad : Buffer.from(opts.aad, "utf8");
  const markerBuf = Buffer.from(`${MARKER}:`, "utf8");

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      if (aad) cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${MARKER}:${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
    },
    decrypt(ciphertext: string): string {
      const prefix = Buffer.from(ciphertext.slice(0, markerBuf.length), "utf8");
      // Constant-time marker compare, then a structural length check, before touching the crypto.
      if (prefix.length !== markerBuf.length || !timingSafeEqual(prefix, markerBuf)) {
        throw new Error("[cipher] not a vsc1 ciphertext (wrong format, or a pre-cipher cleartext value)");
      }
      const raw = Buffer.from(ciphertext.slice(markerBuf.length), "base64url");
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("[cipher] ciphertext too short");
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ct = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      // .final() throws if the tag does not verify: wrong key, tampered ciphertext, or wrong/absent AAD.
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    },
  };
}
