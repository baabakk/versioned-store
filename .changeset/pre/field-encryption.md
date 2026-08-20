---
"@versioned-store/core": minor
"@versioned-store/prompt-store": minor
"@versioned-store/scaffold-store": minor
---

Add opt-in field-level encryption at rest.

A sensitive config value (an API secret embedded in a config blob) was stored plaintext in the backend. This adds an optional at-rest cipher without becoming a secrets manager (key storage, leasing, and rotation stay the host's).

- **core:** a `StoreCipher` interface (`encrypt`/`decrypt` over opaque strings, sync or async) plus `cipher?` and `encryptedFields?` on `VersionedStoreConfig`. The store encrypts named fields AFTER `toDoc` on write and decrypts them BEFORE `fromDoc` on read; `encryptedFields` defaults to every field `toDoc` emits, or names a subset to keep the rest queryable at rest. The content hash and the eval-gate stay over the PLAINTEXT value, so dedup, `syncDefaults` change-detection, and gating are all unchanged, and a randomized cipher carries no dedup penalty. Every unreadable case (wrong key, tampered ciphertext, a pre-cipher cleartext version) fails CLOSED to the code default.
- **core (`@versioned-store/core/cipher` subpath):** a ready-made `createAesGcmCipher({ key, aad? })` (AES-256-GCM over node:crypto, zero dependencies). Fresh random IV per record; output is `vsc1:<base64url(iv|tag|ciphertext)>`; `decrypt` verifies the GCM tag and throws on any tamper. The main entry stays free of an opinionated cipher.
- **prompt-store / scaffold-store:** `cipher?` and `encryptedFields?` threaded through both facades.

Additive; no breaking changes. Versions are immutable, so enabling the cipher protects future versions only: a version written before it stays cleartext and now fails to decrypt (fail-closed), so a clean migration enables the cipher, re-publishes, and then rotates the secret. Threat model: protects the backend at rest, NOT a live compromised process (which holds the key and the decrypted resolve cache).
