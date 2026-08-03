---
"@versioned-store/core": minor
---

Add `isVersionedStoreError(e)` type guard for robust error detection across duplicate package copies.

`VersionedStoreError` is now branded with a global-registry symbol (`Symbol.for`), and the new `isVersionedStoreError` guard checks that brand instead of prototype identity. A blanket `catch (e) { if (isVersionedStoreError(e)) ... }` now covers errors thrown even by a second loaded copy of the package (a transitive version split, or a bundler that duplicates it), where `e instanceof VersionedStoreError` silently returns false. Existing `instanceof` checks keep working for the common single-copy case; the guard is the additional, copy-robust path. Same hazard class and remedy as the zod-`instanceof` fix in `@versioned-store/prompt-store@0.1.0-alpha.1`.
