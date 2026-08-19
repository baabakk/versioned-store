---
title: Consuming the store
---

# Consuming the store

This page covers the three behaviors consumers most often have to verify by reading the source: how resolution and caching actually work, how `{{placeholder}}` rendering behaves, and what guarantees the `onEvent` sink gives. If you are wiring the store into an application, read this before you design around an assumption.

## The rule of one construction site

Wire the store ONCE at a composition root and export a typed facade. Every other file imports from that facade, never from `@versioned-store/*` directly.

```ts
// src/config/prompts.ts — the one construction site
import { createVersionedStore, setStoreLogger } from "@versioned-store/core";
import { createPostgresBackend } from "@versioned-store/core/backends/postgres";
import { logger, pool } from "../infra.js";

setStoreLogger(logger);                 // inject your pino-compatible logger once
const prompts = createVersionedStore<Prompt>(promptCfg, createPostgresBackend(pool));

// the typed facade the rest of the app imports
export const resolvePrompt = (key: string) => prompts.resolve(key);
export const promotePrompt = prompts.promote;
```

This makes every future upgrade a one-file change on your side: fifty call sites become one file to touch. It also gives you the single place to add a gate, so a promote cannot bypass it.

## Resolution and caching

`resolve(key)` does two reads, and they are cached differently. This distinction is the whole performance story, so it is worth stating plainly.

1. **The label pointer is read FRESH on every resolve.** It is never cached, because it is the thing that moves. A `promote` therefore takes effect on the very next resolve, in every process, with no cache invalidation step and no coordination between workers.
2. **The version CONTENT is cached forever, per `(key, version)`.** A version is immutable by construction, so a cached entry can never go stale. There is no TTL and no eviction concern for correctness.

The consequences worth designing around:

- A **warm** resolve (a version already seen in this process) costs one label read plus a map hit. On an embedded backend that is syscall or map cost; on a networked backend it is bounded by exactly one round trip, never a full re-read of the payload.
- A **cold** resolve (the first touch of a key, or the first resolve after a promote moved the label to a version this process has not seen) costs the label read plus one version read. Every subsequent resolve of that version is warm.
- **Do not add your own cache in front of `resolve` for a value whose freshness matters.** Caching the resolved value reintroduces exactly the staleness the fresh label read exists to avoid. This matters most for anything policy-shaped: if you check a permission or a safety rule before a consequential action, resolve it at the moment of acting, not once at startup. A cached policy is a policy you cannot roll back quickly, which defeats the point of the movable label.

If a hot loop reads a config thousands of times per second and staleness of a few seconds is genuinely acceptable, a short-TTL cache in your facade is reasonable. Make that an explicit, per-key decision, never a blanket wrapper.

## Fallback, and what "never a hard dependency" means

`resolve` falls back to the in-code default (reported as the sentinel version 0) in five situations: the backend is unavailable, no label exists for the key, the label points at a version that is missing, the stored value fails to load or decrypt, or the read throws. It does not throw in any of these cases.

That is what makes the store safe to put in front of a boot path: a database outage degrades you to the values compiled into your build, rather than taking the service down. The corollary is that your in-code defaults must be sound, because they are what gets served on the worst day. `checkDefaults(gate)` verifies exactly that, and `seedDefaults` / `syncDefaults` will refuse to promote a default that fails its gate.

Set `codeDefaultIsFirstClass: true` when serving the in-code default is normal operation for your domain rather than an alarm, which keeps the fallback logs at debug instead of warn.

## Placeholder rendering (prompt-store)

`@versioned-store/prompt-store` uses `{{name}}` placeholders with strict binding. The behavior is deliberately unforgiving, because a silently half-rendered prompt is worse than a loud failure.

- Every `{{placeholder}}` in the text must be bound at render time. A leftover placeholder throws rather than reaching a model.
- A variable whose value contains `{{` or `}}` has those sequences neutralized before substitution, so a value cannot inject a placeholder or corrupt the leftover check.
- When a Zod var schema is registered for the key, the variables are validated against it at render, and the promote gate additionally refuses a version containing a placeholder the schema does not declare.
- Substitution is plain string replacement. There are no conditionals, loops, or expressions. That is intentional: the store versions prompt TEXT, it is not a template language. If your prompt needs conditional sections or iteration, keep that assembly in code and version the fragments it composes.

The practical migration note: when converting an existing backtick template to `{{placeholder}}` form, the golden-render gate catches a renamed or unknown placeholder, but it cannot tell you that a value formatted one way in the old code path formats differently in the new one. Diff the rendered output against the old code path once, with real inputs, before you promote.

## The `onEvent` sink

`onEvent` fires on every store event: `fallback`, `gate-outcome`, `promote-refused`, and `promote-accepted`. It is how you capture a durable audit trail, including promotions that bypass your own wrapper code (a script, an admin route, the CLI), because it fires at the source inside the library.

Three properties to design around:

- **It is synchronous and fire-and-forget.** The store calls your sink and discards the return value. It does not await anything.
- **Errors are swallowed.** A throwing sink logs a warning and never disrupts a promote or a resolve. An audit row must never break a kill switch.
- **It fires once per event, and delivery is not retried.** Your sink must therefore be idempotent if it triggers a side effect (a push notification, a webhook), because a caller can promote the same version twice and you will see two events. If your sink writes asynchronously, wrap it with `createDrainableSink` so a short-lived process can flush before exit; a bare detached write is lost when a CLI closes its connection immediately after the verb.

```ts
import { createDrainableSink } from "@versioned-store/core";

const sink = createDrainableSink(async (event) => {
  await auditCollection.insertOne({ ...event, recordedAt: new Date() });
});

const store = createVersionedStore({ ...cfg, onEvent: sink.onEvent }, backend);

// in a CLI or any short-lived process, before closing the backend:
await sink.drain();
```

Persisting the `promote-accepted` events is what makes "which version was live at time T" answerable. The movable label alone cannot tell you, because each promote overwrites it.

## Errors

Every error the library throws extends `VersionedStoreError`, so one blanket catch covers it. Prefer the `isVersionedStoreError(e)` guard over `instanceof`, because the guard still matches when a second copy of the package is loaded (a version split, or a bundler that duplicates it), where `instanceof` silently returns false.
