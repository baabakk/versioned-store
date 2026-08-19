# Security Policy

## Supported versions

`@versioned-store/*` is pre-release. Security fixes land on the newest published alpha of the `0.x` line. There is no long-term-support branch yet; if you are pinned to an older alpha, expect to upgrade to receive a fix.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately by either route:

- Email **security@versioned-store.dev**, or
- Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and choose **Report a vulnerability**. This opens a private advisory visible only to the maintainers.

Please include:

- A clear description of the issue and its impact
- Steps to reproduce
- Proof-of-concept code or logs, if you have them
- A suggested fix or mitigation, if you have one

## Response process

Maintainers will:

1. Acknowledge receipt within 3 business days
2. Confirm impact and triage severity
3. Work on a fix and coordinate disclosure timing with you
4. Publish a patched release and a public advisory once a fix is available

## Disclosure policy

Responsible disclosure. Details stay private until a fix is released or a mitigation is communicated.

## Scope notes

Some properties of this library are worth stating explicitly, because they shape what counts as a vulnerability here.

**Scaffold and command execution.** `@versioned-store/scaffold-store` stores command strings and renders them; it never executes anything. Running a rendered command is the host application's decision, in the host's own process and shell. The store's promote-gate constrains what a spec may declare (a pinned version, bound placeholders, an allowlisted executable), and that gate is a correctness and reproducibility control. **It is not a sandbox.** A host that promotes a spec from an untrusted source and shells the result out is executing untrusted input, and the gate is not what stands between it and harm.

**Payload trust.** `@versioned-store/core` stores and returns an arbitrary payload `T`. It does not sanitize or interpret it. If your payload reaches an interpreter, a shell, or a template renderer, that boundary is yours to defend.

**Confidentiality at rest.** By default a payload's fields are stored as written: a value you place in a versioned store sits in your backend in the clear. For a sensitive-but-not-credential value, the store offers OPTIONAL field-level encryption. Set a `cipher` (a `StoreCipher`) and, optionally, `encryptedFields` on the store config; the store encrypts those fields after `toDoc` and decrypts them before `fromDoc`, while the content hash and the eval-gate stay over the plaintext, so promotion behavior is unchanged. A ready-made AES-256-GCM cipher is at `@versioned-store/core/cipher` (`createAesGcmCipher({ key })`), or supply your own (for example, KMS-backed).

The threat model is deliberate: this protects the backend AT REST (a leaked database dump, a stolen disk). It does NOT protect a live compromised process, which holds the key and the store's decrypted resolve cache. It is NOT a secrets manager: key storage, leasing, and rotation are the host's job. For an actual credential such as a long-lived API key, a dedicated secrets manager is the right tool; the store's cipher is confidentiality for a config blob that happens to carry a sensitive field, not credential governance.

Enabling the cipher protects FUTURE versions only. Versions are immutable, so a value written before the cipher was enabled stays in the clear, and a cipher-on read of it fails closed to the code default. A clean migration is: enable the cipher, re-publish the value so a new encrypted version becomes active, then ROTATE the secret, because the pre-cutover cleartext remains in the immutable history until the secret it held is dead. One caveat on the stored hash: the store keeps a `sha256` content hash computed over the plaintext and stored alongside the encrypted fields, so use a one-way hash. The domain packages default to SHA-256, which does not reveal the plaintext; a weak or identity `hash` would leak it through the stored digest even with the fields encrypted.

**Code-default soundness.** The in-code default is the store's safety net: it is served on every fallback (backend unreachable, key unseeded, a stored value that fails validation or decryption) AND it is the value an operator recovery re-promotes. So a default that could not itself pass the domain's eval-gate would be served, and could be promoted, unvalidated. `store.checkDefaults(gate)` runs every registered default through a supplied gate and reports whether each could go live; the domain packages expose a zero-argument `checkDefaults()` that reuses their own promote-gate. The policy on an unhealthy default (fail at boot, warn, degrade) is the host's; the library only reports. Verifying your defaults are gate-valid is the host's responsibility.

**Sealed bundles.** `bundle.ts` supports HMAC signing so tampering is detected at import. Signing is optional: an unsigned bundle is content-addressed but not authenticated, so an unsigned bundle from an untrusted source proves nothing about its origin. Sign bundles that cross a trust boundary, and keep the secret out of the repository.

**Backends.** Backends are injected by the host. Connection strings, credentials, and network exposure for Postgres, Mongo, and Redis are the host's responsibility; this library never constructs a connection or reads an environment variable to find one.
