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

**Sealed bundles.** `bundle.ts` supports HMAC signing so tampering is detected at import. Signing is optional: an unsigned bundle is content-addressed but not authenticated, so an unsigned bundle from an untrusted source proves nothing about its origin. Sign bundles that cross a trust boundary, and keep the secret out of the repository.

**Backends.** Backends are injected by the host. Connection strings, credentials, and network exposure for Postgres, Mongo, and Redis are the host's responsibility; this library never constructs a connection or reads an environment variable to find one.
