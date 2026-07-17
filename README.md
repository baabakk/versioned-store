# versioned-store

An embedded-first, storage-portable, immutable-versioned config primitive with an **eval-gate coupled to promote**, over arbitrary payload `T`.

## Packages

| Package | What it is |
|---|---|
| [`@versioned-store/core`](packages/core) | The generic primitive: immutable versions, a movable label pointer, a code-default fallback, and a promote-gate, over any payload `T`. Backends: SQLite (`node:sqlite`), File, InMemory, Postgres, Mongo, Redis. Plus migration, signed portable bundles, canary/shadow with gate-driven auto-rollback, a CLI, and an exported conformance suite. |
| [`@versioned-store/prompt-store`](packages/prompt-store) | A batteries-included **prompt store** built on the core: strict `{{placeholder}}` rendering, Zod var-schema validation, unknown-placeholder detection, and a deterministic golden-render promote-gate. |
| [`@versioned-store/scaffold-store`](packages/scaffold-store) | A batteries-included **scaffold store** built on the core: strict `{placeholder}` command rendering, injected key routing, and a deterministic promote-gate over pinning, placeholder binding, and an executable allowlist. |

The two domain packages are worked examples of the same shape: payload, rendering, and a domain gate on top; policy and storage below. Neither adds a mechanism to the core.

## The pitch, and the honest gap

The defensible thing is the runtime **pairing**, not any single piece:

- the **eval-gate coupled to promote**, so a bad edit physically cannot go live, plus
- the **code-default fallback**, so the store is never a hard dependency,
- both over **arbitrary payload `T`**, embedded-first, with SQLite by default.

Conceded table stakes, openly: immutable versions of an arbitrary payload (AWS AppConfig has this), a movable pointer (SSM Parameter Store labels, Dolt branches, MLflow aliases), and a deploy-time gate (AppConfig validators, Langfuse eval-before-production, LaunchDarkly approvals; Buf and Confluent compatibility checks even run offline). The closest incumbent is the MLflow Prompt Registry. The claim here is only the bundle, not any one property.

## Develop

```bash
npm install
npm run build     # core builds first; the domain packages resolve its dist
npm test
```

Node 22+ is needed to run the suite (the SQLite backend uses the built-in `node:sqlite`). The published packages support Node 18+: every main entry is dependency-free, and anything needing a driver (`node:sqlite`, `pg`, `mongodb`, the CLI) is a subpath export. CI proves both halves, importing each main entry on real Node 18 and 20.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the architecture rules, and how to add a changeset. [SECURITY.md](SECURITY.md) covers private disclosure and the trust boundaries.

## Certifying a backend

Any backend, including a third-party one, can prove itself against the same suite this repo runs:

```ts
import { runConformance } from "@versioned-store/core/conformance";
runConformance("MyBackend", () => makeMyBackend());
```

If it is green, the adapter honours immutability, compare-and-swap, version ordering, and labels.

MIT.
