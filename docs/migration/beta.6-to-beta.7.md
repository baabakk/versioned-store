---
title: Upgrading from 0.1.0-beta.6 to 0.1.0-beta.7
---

# Upgrading from `0.1.0-beta.6` to `0.1.0-beta.7`

**No consumer edits are required.** Everything in this release is additive: new exports, a new subpath, one new field on a report, and one new warning. Nothing was removed, renamed or narrowed, and no behaviour changed.

This guide exists anyway, because a release that needs no changes is itself useful information, and because two of the additions are worth adopting deliberately rather than discovering later.

## Upgrade

```bash
npm install @versioned-store/core@0.1.0-beta.7 \
            @versioned-store/prompt-store@0.1.0-beta.7 \
            @versioned-store/scaffold-store@0.1.0-beta.7 \
            @versioned-store/cli@0.1.0-beta.7
```

Move the family together and confirm one physical copy afterwards with `npm ls @versioned-store/core`.

## What this release is for

The next release announces several behaviour changes, each with a deprecation warning and a removal some releases later. That promise is only worth making if the warnings arrive, and until now they would not have: the library had no deprecation helper, and its logging is silent until a host injects a logger. A consumer that never injects one would have received nothing at all and met the removal cold.

So this release builds the channel and changes nothing else. **If you injected no logger, you will now still receive deprecation warnings**, on the console, once per warning per process.

## What you may want to adopt

### `@versioned-store/core/contract`, so you can catch our errors without breaking your own façade rule

The README asks you to wire the store once and import from your own façade everywhere else. It also asks you to catch our typed errors, which meant importing this package in a route handler, which is the one place the first rule forbids. One consumer followed the façade rule, used none of our typed errors, flattened a gate refusal to a string and lost the `failures` list on the way to its dashboard.

The new subpath carries the error classes, the brand guard, and the result and gate types, with no backend, cipher or store construction behind it. It is safe to import anywhere.

```ts
// in your façade
export { isVersionedStoreError, GateRejectedError } from "@versioned-store/core/contract";
export type { GateResult, Resolved, SeedResult } from "@versioned-store/core/contract";

// in a route handler, importing from your façade as usual
catch (err) {
  if (err instanceof GateRejectedError) return res.status(422).json({ failures: err.failures });
  throw err;
}
```

Send `failures` as the array it is. A gate refusal is a list of reasons, and flattening it to a string loses the thing an operator needs.

### Controlling where warnings go

```ts
import { setWarningHandler, suppressWarning } from "@versioned-store/core";

setWarningHandler((message, key) => logger.warn({ key }, message)); // route into structured logging
suppressWarning("encrypted-fields-without-cipher");                 // silence one you have handled
```

Delivery order is: your handler if you set one, otherwise your injected logger if you wired one, otherwise the console. Every warning fires at most once per key per process.

## One new warning, which may fire on your existing configuration

If a store names `encryptedFields` and no `cipher` is configured, those fields are stored in **plaintext**, and the library now says so once at construction.

This is not a behaviour change: it has always been the case, and naming fields without a cipher has always been inert. The warning exists because the mistake is silent and points the dangerous way: a consumer who wrote `encryptedFields` believes those values are encrypted at rest.

If you see it, either pass a cipher or drop `encryptedFields`. If your values are genuinely not secret and the field list is there for another reason, suppress the key.

The reverse case, a `cipher` with no `encryptedFields`, does **not** warn and is not a mistake: an absent field list means every field is encrypted.

## One new field

`checkDefaults()` now also returns `checked`, the number of code defaults it examined.

It changes nothing about what the check does. It is there so a partial pass cannot read as a full one: if you register keys lazily, for instance a key carrying a tenant or user id that cannot be in a construction-time map, this store has never been told about those keys and `ok: true` says nothing about them. Compare `checked` against your own registry.

## What has not changed

- No method was removed, renamed or narrowed.
- No behaviour changed. The one new warning reports a condition that was already true.
- The resolve path, the caching model, the fallback contract and the event schema are untouched.
