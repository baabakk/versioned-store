# versioned-store

An embedded-first, storage-portable, immutable-versioned config primitive with an **eval-gate coupled to promote**, over arbitrary payload `T`.

## Packages

| Package | What it is |
|---|---|
| [`@versioned-store/core`](packages/core) | The generic primitive: immutable versions, a movable label pointer, a code-default fallback, and a promote-gate, over any payload `T`. Backends: SQLite (`node:sqlite`), File, InMemory, Postgres, Mongo, Redis. Plus migration, signed portable bundles, canary/shadow with gate-driven auto-rollback, a CLI, and an exported conformance suite. |
| [`@versioned-store/prompt-store`](packages/prompt-store) | A batteries-included **prompt store** built on the core: strict `{{placeholder}}` rendering, Zod var-schema validation, unknown-placeholder detection, and a deterministic golden-render promote-gate. |

## The pitch, and the honest gap

The defensible thing is the runtime **pairing**, not any single piece:

- the **eval-gate coupled to promote**, so a bad edit physically cannot go live, plus
- the **code-default fallback**, so the store is never a hard dependency,
- both over **arbitrary payload `T`**, embedded-first, with SQLite by default.

Conceded table stakes, openly: immutable versions of an arbitrary payload (AWS AppConfig has this), a movable pointer (SSM Parameter Store labels, Dolt branches, MLflow aliases), and a deploy-time gate (AppConfig validators, Langfuse eval-before-production, LaunchDarkly approvals; Buf and Confluent compatibility checks even run offline). The closest incumbent is the MLflow Prompt Registry. The claim here is only the bundle, not any one property.

## Develop

```bash
npm install
npm run build -w @versioned-store/core        # build core first (prompt-store resolves its dist)
npm run build -w @versioned-store/prompt-store
npm test --workspaces
```

## Certifying a backend

Any backend, including a third-party one, can prove itself against the same suite this repo runs:

```ts
import { runConformance } from "@versioned-store/core/conformance";
runConformance("MyBackend", () => makeMyBackend());
```

If it is green, the adapter honours immutability, compare-and-swap, version ordering, and labels.

MIT.
