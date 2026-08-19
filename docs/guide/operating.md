---
title: Operating a store
---

# Operating a store

Versioning config is only half the job. This page covers the operator side: how a change goes live, how to take it back, and what stops a broken value from ever being served.

## The promote path

A change reaches production in two deliberate steps.

```ts
const v = await store.addVersion("greeting", { text: "Hi there!" });  // recorded, NOT live
await store.promote("greeting", v, { gate: myGate, by: "ada", note: "warmer tone" });
```

`addVersion` always succeeds and always writes an immutable version, so a candidate can be captured, reviewed, and diffed without any risk of it serving traffic. `promote` is the only thing that moves the `active` label, and it is where the gate runs. A candidate that fails its domain gate throws `GateRejectedError` and the label does not move, so a broken value sits inactive rather than going live.

Always pass `by` and `note`. They persist on the label and ride the `promote-accepted` event, which is what makes the audit trail answer "who changed this at 03:14, and why" rather than just "it changed".

## The gate is the whole point

`core.promote` treats the gate as OPT-IN: it runs only when you pass `opts.gate`. That is a deliberate primitive-level choice, but it means a direct call with no gate flips a value live unvalidated.

**Wrap it.** Expose exactly one promote path in your application, with the gate baked in, and let nothing else call the raw one:

```ts
// the ONLY promote path for configs
export async function promoteConfig(key: string, version: number, opts?: { by?: string; note?: string }) {
  return store.promote(key, version, { ...opts, gate: gateFor(key) });
}
```

An opt-in safety check on a path an operator reaches during an incident is a safety check that will eventually be skipped. The domain packages (`prompt-store`, `scaffold-store`) already do this for you: their `promote` has the domain gate baked in and cannot be called without it.

Write the gate against the shape the CONSUMER actually reads, not a generic "is this valid JSON". A gate that only checks parseability waves through the failure mode that actually happens: a well-formed document whose one load-bearing field moved, so every read silently gets nothing.

## Rolling back

Three options, in order of preference.

1. **Promote a known-good version.** `promote(key, previousVersion)` is the normal rollback: the label moves back, gated, in one operation. Versions are immutable, so the old value is exactly what it was.
2. **`revertToCodeDefault(key)`** is the single-key kill switch. It adds the in-code default as a new version and promotes it, UNGATED by design, because a kill switch a gate can block is not a kill switch. Prefer it over the other two when you need the key back to a known-safe state now.
3. **`syncDefaults()`** is a GLOBAL reconcile across every registered default. It is not a rollback verb. Never call it at boot, and never reach for it to fix one key.

Note that `promote(key, 0)` throws. Version 0 is the in-memory sentinel for the code default, never a stored version; the error points you at `revertToCodeDefault`.

## Seeding, and why a default must be sound

`seedDefaults()` is idempotent and safe to call at boot: for each key with no versions, it inserts the in-code default as v1 and promotes it. Existing versions are never overwritten.

Because seeding PROMOTES, an unsound default would be made active without ever passing a gate. Pass a gate and it will refuse instead:

```ts
const report = await store.seedDefaults({ gate: myGate });
const refused = report.filter((r) => r.refused);
```

A refused default is skipped, reported with its failures, and never promoted. Seeding never throws on one, so a single bad default cannot halt the seed. The domain packages always gate their seed automatically.

Separately, `checkDefaults(gate)` verifies every registered default could pass its gate, touching no backend at all. Run it at boot: the in-code default is what gets served when the backend is unreachable, so an unsound default is a latent outage. The policy on failure (crash, warn, degrade) is yours.

## The CLI

`@versioned-store/cli` turns constructed stores into an operator surface with a uniform verb set across every domain:

```
store-admin list [key]              list keys, or one key's versions
store-admin add <key> <payload>     add a new INACTIVE version
store-admin promote <key> <ver>     move the active label, GATED
store-admin revert <key>            kill switch: re-promote the in-code default
store-admin diff <key>              active version vs the in-code default
store-admin seed | sync             reconcile code defaults (refusals exit non-zero)
store-admin health                  run every default through its gate
```

Two properties make it safe to hand to an operator under pressure. The descriptor exposes only the GATED promote, so the CLI cannot reach the ungated one; and `health` covers every registered domain, so an operator surface cannot silently omit a payload family. Its lifecycle also drains the audit sink before closing the backend, so a promote's audit row survives a short-lived process.

## Canary

`resolveWeighted` serves a canary version to a fraction of resolves, and `evaluateCanary` demotes it automatically when the gate fails. Percentage rollout of a payload is in scope; user targeting and experimentation are not, and belong in your application.
