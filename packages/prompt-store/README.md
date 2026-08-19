# @versioned-store/prompt-store

A batteries-included, versioned **prompt store** with a deterministic promote-gate, built on `@versioned-store/core`. Version your LLM prompts, eval-gate them before they go live, and roll back on regression.

## Why

Prompts are code that ships to production without a build. This gives them the same discipline: immutable versions, a movable `active` label, and a **promote-gate** that renders every candidate over your golden inputs and validates its variable schema, so a broken prompt physically cannot go live.

## Quickstart

```ts
import { createInMemoryBackend } from "@versioned-store/core";
import { createPromptStore } from "@versioned-store/prompt-store";
import { z } from "zod";

const prompts = createPromptStore({
  backend: createInMemoryBackend(), // or SQLite/Postgres/Mongo/File/Redis from @versioned-store/core
  defaults: { greeting: { text: "Hello, {{name}}!" } }, // code-default, served until a version is promoted
  varSchemas: { greeting: z.object({ name: z.string() }) },
  goldens: { greeting: [{ name: "World" }] },
});

await prompts.seedDefaults();
const text = await prompts.renderPrompt("greeting", { name: "Ada" }); // "Hello, Ada!"

// A regressing edit is refused at promote:
const v = await prompts.addPromptVersion("greeting", "Hi {{name}} from {{unknown}}");
await prompts.promote("greeting", v); // throws: {{unknown}} is not in the var schema
```

## What you get

- **Immutable prompt versions** + a movable `active` label (promote / rollback).
- **Code-default fallback** — the store is never a hard dependency; an unseeded or backend-down key serves the in-code prompt.
- **A deterministic promote-gate** — render over golden inputs + Zod var-schema validation + unknown-placeholder detection. A broken prompt sits inactive.
- **Storage-portable** — bring any `@versioned-store/core` backend (SQLite by default; Postgres / Mongo / Redis / File / InMemory).
- **Arbitrary breadth** — need to version non-prompt config too? Use `@versioned-store/core` directly.
- **Promotion audit + history:** pass an `onEvent` sink and every promote (ungated reverts and out-of-band scripts included) is captured at the source, so promotion history is queryable rather than reconstructed from logs.
- **A single-key kill-switch:** `revertToCodeDefault(key)` returns one key to its in-code default, ungated, when a live version misbehaves.
- **A defaults health check:** `checkDefaults()` verifies every code-default prompt can itself pass the promote-gate, so your fallback is never an unsound prompt.
- **Encryption at rest (opt-in):** pass a `cipher` to keep stored prompts confidential at rest; the content hash and the golden-render gate stay over the plaintext.

## Audit and rollback

Pass an `onEvent` sink to persist an at-source trail of every promotion, and annotate each promote with a `note` and structured `refs`:

```ts
const prompts = createPromptStore({
  backend: createInMemoryBackend(),
  defaults: { greeting: { text: "Hello, {{name}}!" } },
  varSchemas: { greeting: z.object({ name: z.string() }) },
  goldens: { greeting: [{ name: "World" }] },
  onEvent: (e) => auditLog.append(e), // fallback, gate-outcome, promote-refused, promote-accepted
});

const v = await prompts.addPromptVersion("greeting", "Hey {{name}}!");
await prompts.promote("greeting", v, { by: "ada", note: "warmer tone", refs: { pr: 412 } });
// note + refs persist on the label and ride the promote-accepted event.

// If a live version misbehaves, revert one key to its in-code default (ungated):
await prompts.revertToCodeDefault("greeting", { by: "ada", note: `regression in v${v}` });
```

The sink fires alongside the injected logger, and its errors are swallowed, so a failing audit sink never disrupts a promote or a resolve.

## Checking your defaults

The code-default prompt is served on every fallback and is what `revertToCodeDefault` re-promotes, so it must be able to pass the same gate a candidate must. `checkDefaults()` runs every default through the store's own promote-gate (unknown-placeholder + golden-render) and reports whether each could go live, without touching the backend:

```ts
const report = await prompts.checkDefaults();
if (!report.ok) {
  // report.results is [{ key, passed, failures }]; the policy (fail at boot, warn, degrade) is yours.
  const bad = report.results.filter((r) => !r.passed).map((r) => r.key);
  throw new Error(`unsound default prompts: ${bad.join(", ")}`);
}
```

## Encryption at rest

To keep a stored prompt confidential at rest (a prompt that embeds a sensitive value), pass a `cipher`. The store encrypts the payload fields after mapping and decrypts them before rendering; the content hash and the golden-render gate stay over the plaintext, so promotion behavior is unchanged. A zero-dependency AES-256-GCM cipher ships at `@versioned-store/core/cipher`:

```ts
import { createAesGcmCipher } from "@versioned-store/core/cipher";

const prompts = createPromptStore({
  backend,
  defaults: { greeting: { text: "Hello, {{name}}!" } },
  cipher: createAesGcmCipher({ key: myKey }), // 32-byte Buffer or its base64
  encryptedFields: ["text"], // default: every field (text and config)
});
```

This protects the backend at rest, not a live compromised process, and it is not a secrets manager. See [SECURITY.md](../../SECURITY.md) for the threat model and the migration path.

`zod` is a peer dependency: bring your own copy, and any `zod@^3.23 || ^4` works. Var-schema fields are detected structurally (by the schema's `.shape`), not by `instanceof`, so validation and the unknown-placeholder gate work correctly even if your dependency tree happens to resolve more than one copy of zod. MIT.
