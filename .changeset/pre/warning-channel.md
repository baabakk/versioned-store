---
"@versioned-store/core": minor
---

A warning channel that reaches a consumer who wired no logging, plus a contract entry point for types and errors.

**Why this release exists.** The releases after this one announce behaviour changes with a deprecation warning and a removal some releases later. That promise is only worth making if the warnings arrive. Until now they would not have: there was no deprecation helper, and store logging is silent until a host injects a logger, so a consumer who never injects one would have received nothing and met the removal with no notice.

- **`warnOnce`, `warnDeprecated`, `setWarningHandler`, `suppressWarning`.** Delivery order is an explicit handler, then the injected logger, then `console.warn`. Every warning fires at most once per key per process, any key can be suppressed by a consumer who has already migrated, and a throwing handler can never break the operation that triggered the warning. A deprecation states what is deprecated, what to use instead, and the release the removal is expected in.

- **`@versioned-store/core/contract`**, a new subpath carrying the error classes, the brand guard, and the result and gate types, with no backend, cipher or store construction behind it. The README asked consumers to import from their own façade everywhere outside the construction site AND to catch our typed errors, which are contradictory instructions for anyone whose error handling lives in a route handler. One consumer followed the first rule, used none of our typed errors, and flattened a gate refusal to a string, losing the `failures` list. The README now says which to import from where.

- **A warning when `encryptedFields` is set with no `cipher`.** Those fields are stored in plaintext, which has always been true and was silent, and the mistake points the dangerous way: the consumer believes they are encrypted. The reverse, a cipher with no field list, is not warned about, because an absent list means every field is encrypted.

- **`checkDefaults()` now reports `checked`**, the number of defaults it examined, so a partial pass cannot read as a full one. A consumer registering keys lazily should compare it against its own registry.

- **The published packages no longer carry internal references.** A shipped CLI message told public users to run scripts in a repository they cannot open. A publish-time gate now greps the BUILT output and fails, because the existing check scans staged diffs and these lines were never wrong as source.

Additive: nothing removed, renamed or narrowed, and no behaviour changed.
