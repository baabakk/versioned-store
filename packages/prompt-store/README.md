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

`zod` is a peer dependency. MIT.
