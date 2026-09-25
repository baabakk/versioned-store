---
title: Upgrading from 0.1.0-alpha.5 to 0.1.0-beta.6
---

# Upgrading from `0.1.0-alpha.5` to `0.1.0-beta.6`

**Short version: nothing was removed or narrowed, and no call site has to change.** Both changes in this release are additive. Two things can still surprise you, and one of them can fail a type check, so they are described in full below.

This release is the API freeze. From here, no breaking change ships without a deprecation cycle.

## Upgrade

```bash
npm install @versioned-store/core@0.1.0-beta.6 \
            @versioned-store/prompt-store@0.1.0-beta.6 \
            @versioned-store/scaffold-store@0.1.0-beta.6 \
            @versioned-store/cli@0.1.0-beta.6
```

Move the whole family together. The packages are released as a linked set and share a version, and mixing versions risks loading two copies of the core, in which case an `instanceof` check across the boundary silently returns false. After installing, confirm one physical copy:

```bash
npm ls @versioned-store/core
```

## What can fail your build

**If you restated `SeedResult` or `SyncResult` by hand, they gained an outcome.** Verify-on-seed added a `refused` case, so a hand-written copy of either type is now too narrow, and a strict TypeScript compiler will say so at the assignment.

This is the failure worth having: it is loud, it happens at compile time, and the fix is to stop restating the type.

```ts
// Before: a local restatement that drifts the moment the library adds an outcome
type SyncOutcome = { key: string; action: "added" | "skipped" };

// After: re-export the library's own type through your facade
export type { SeedResult, SyncResult } from "@versioned-store/core";
```

If your facade does not expose these types today, this is the moment to add them, because a consumer threading a result through its own signatures otherwise has nowhere to get the type from.

## What changes behaviour without failing anything

**Seeding now refuses an unsound default instead of promoting it.** Previously `seedDefaults` and `syncDefaults` promoted the code default to active without checking it, so a default that could not pass its own gate became the live version unvalidated. That was the "seed hole".

- On the **core**, `seedDefaults(opts?)` and `syncDefaults(opts?)` accept an optional `{ gate }`. Behaviour is unchanged unless you pass one.
- On **`prompt-store` and `scaffold-store`**, the facade now **always** injects the same gate that `promote` uses. There is nothing to opt into, and this is the behaviour change: a default your gate would refuse is now skipped and reported rather than made active.
- On the **CLI**, a descriptor may carry a `gate`; when it does, `seed` and `sync` report refusals and exit non-zero.

A refused default is still **served**, through the normal fallback path as the sentinel version 0. Refusing to promote it is not refusing to run. The way to find out at boot is `checkDefaults(gate)`, which runs every default through the gate and returns a report; call it at start-up and decide deliberately whether a failure is fatal.

If a key stops becoming active after this upgrade, that is this change, and the gate is telling you the shipped default was never sound.

## What you may now want to adopt

**Per-store table names on the Postgres backend.** `createPostgresBackend(pool, opts?)` accepts optional table names:

```ts
createPostgresBackend(pool, { versionsTable: "prompt_versions", labelsTable: "prompt_labels" });
```

Nothing forces this. It matters when several stores share one database, because version and label rows are keyed by key alone: two stores over one table pair share one key namespace, and a prompt key and a config key with the same name will write into each other's rows. The Mongo backend has taken collection names since earlier.

**One caution if you already hold production rows.** Switching an existing store to new table names does not move the rows it already wrote. The versions are immutable by design, so migrating them is a copy, not a rename. If you are already live on the default tables and your keys do not collide, staying put and guarding the namespace in your own code is a legitimate choice. Decide it deliberately rather than by default.

## What this release does not change

- No method was removed, renamed or narrowed.
- The resolve path, the caching model and the fallback contract are untouched.
- The event schema did not change version.
- Existing gates, ciphers and backends keep working as written.

## If something surprised you

That is a documentation defect worth reporting. This guide exists because two consumers upgraded across this release and each carried a slightly different second-hand account of what it did, one of them describing an added optional parameter as a changed signature. If your experience does not match this page, the page is what should change.
