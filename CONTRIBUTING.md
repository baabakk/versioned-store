# Contributing to versioned-store

Thanks for considering a contribution. This document covers how to propose changes.

## Quick start

```bash
git clone https://github.com/baabakk/versioned-store.git
cd versioned-store
npm install
npm run build        # core builds first; the domain packages resolve its dist
npm test
```

This is an npm workspace. Node 22+ is required to run the test suite, because the SQLite backend uses the built-in `node:sqlite`. The published packages themselves support Node 18+ (see [Entry points](#entry-points-are-load-bearing)).

## What is in scope

The core is deliberately small. Contributions that fit these non-goals will be closed with thanks:

- **Not a hosted service.** No control plane, no dashboard-as-a-requirement, no phoning home.
- **Not a feature-flag platform.** Percentage rollout of a payload is in scope; user targeting, segments, and experimentation are not.
- **Not a config format.** The payload is your `T`. The core does not parse, merge, or template it.
- **Not a migration tool for someone else's schema.** `migrate` moves a store between our own backends.
- **Not a policy engine.** The gate runs your predicate; it does not ship a rules language.

Welcome contributions:

- Bug fixes with a reproducing test
- New backends (must pass the conformance suite; see below)
- New domain packages built on the core, or improvements to the existing ones
- Documentation, examples, migration guides
- Conformance test additions that tighten the backend contract

## Development workflow

1. **Open an issue first** for anything non-trivial, so we agree on the shape before you write code.
2. **Fork and branch.** `feat/<scope>-<topic>`, `fix/<scope>-<topic>`, `docs/<topic>`.
3. **Commit convention:** `<type>(<scope>): <subject>`. For example:
   - `feat(core): add a shadow label to the canary resolver`
   - `fix(backends/postgres): map SQLSTATE 23505 to BackendConflictError`
   - `docs(scaffold-store): document the pinning gate`
4. **Write tests.** Every code change. A new backend means the conformance suite; everything else means unit tests.
5. **Add a changeset** if your change affects a published package:
   ```bash
   npm run changeset
   ```
   Pick the packages, pick the bump, and describe the change for a consumer reading a changelog, not for a reviewer reading a diff. Commit the generated `.changeset/*.md` with your PR.
6. **Open a PR.** CI must pass: tests on Node 22 and 24, main-entry loading on Node 18 and 20, and the publish dry-run.

## Certifying a new backend

A backend is not done until the shared conformance suite is green against it. That suite is the definition of the contract: immutability, compare-and-swap, version ordering, and labels.

```ts
import { runConformance } from "@versioned-store/core/conformance";

runConformance("MyBackend", () => makeMyBackend());
```

Add your factory to the `BACKENDS` list in `packages/core/src/store.test.ts` so it runs in CI alongside the others. A backend that needs a live server should be skippable when the server is absent, so a contributor without it can still run the suite.

## Architecture rules

These are not style preferences; a PR that breaks one will be asked to change.

- **Policy in the core, storage in the backend, domain on top.** No fallback, retry, or gating logic inside a backend. No `if (domain === ...)` inside the core.
- **The core carries zero runtime dependencies.** Only `node:*`. If your change needs a package at runtime in the core, it belongs in a domain package or a backend instead.
- **Backends and loggers are injected, never constructed.** The library never opens a connection or reads an environment variable to find one.
- **Errors extend `VersionedStoreError`.** A consumer's blanket `catch (e instanceof VersionedStoreError)` must keep working; add specificity with a subclass.
- **The event schema is versioned.** Add fields; do not reshape them without bumping `STORE_EVENT_SCHEMA_VERSION`.

### Entry points are load-bearing

The main entry of every package must stay dependency-free and importable on Node 18. Anything requiring a driver is a **subpath export**: `node:sqlite` (Node 22+), `pg`, `mongodb`, and the CLI (which builds a SQLite backend from a spec string).

This is enforced two ways, because it has broken before: `packages/core/src/entry-isolation.test.ts` walks the barrel's static import graph, and CI imports every main entry on real Node 18 and 20. If you find yourself re-exporting something driver-coupled from `index.ts`, that is the rule catching you, not a false positive.

## Code style

- TypeScript strict. ESM only. `.js` extensions in import paths, even from `.ts` sources.
- No `any`. Use `unknown` plus a type guard.
- Comment the *why*, not the *what*. A comment explaining a constraint, a trade-off, or a past failure is valuable; one narrating the next line is not.

## Releases

Releases are cut by the maintainer. The project is in changesets pre-mode on the `alpha` tag, so packages move in lockstep and every published version is a prerelease. Contributors do not need to run `changeset version` or publish; just include the changeset file.

## Security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md). By participating you agree to its terms.
