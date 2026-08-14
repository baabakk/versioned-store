---
"@versioned-store/core": patch
---

Fix: add the missing `note` field to the `VersionedStore.promote` interface.

`promote`'s implementation has accepted an optional `note` since 0.1.0-alpha.3 (it persists on the label and rides the `promote-accepted` event), but the public `VersionedStore` interface omitted it. A TypeScript caller passing `{ note }` therefore failed to type-check against the published `.d.ts` even though the call worked at runtime. The interface now matches the implementation. Runtime behavior is unchanged; this is a types-only correction.

The gap escaped both gates: the test runner strips types (`tsx`), and the build excludes test files, so no compile ever exercised the interface against a `note`-passing caller. The facades' own `core.promote(..., { note })` calls are what surfaced it.
