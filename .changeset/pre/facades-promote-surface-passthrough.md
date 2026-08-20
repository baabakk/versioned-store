---
"@versioned-store/prompt-store": minor
"@versioned-store/scaffold-store": minor
---

Thread the full promote surface through both facades.

`createPromptStore` and `createScaffoldStore` build the core store by PICKING config fields, so the promote-path additions from `@versioned-store/core@0.1.0-alpha.3` were reachable only by calling `createVersionedStore` directly, never through the facade. Since the facade is the high-traffic surface (all the promote traffic goes through it), promotion audit and history were effectively impossible for a facade consumer. Both facades now pass the surface through:

- **`onEvent`:** a new `onEvent?(event)` option on `PromptStoreOptions` / `ScaffoldStoreOptions`, forwarded to the core. A host can now persist an at-source audit trail of promotions through the facade, which is what makes promotion history queryable.
- **`note` + `refs` on `promote`:** both facade `promote` methods now accept `note` and `refs` and forward them, so they persist on the label and ride the `promote-accepted` event.
- **`revertToCodeDefault(key)`:** the ungated single-key kill-switch is now exposed on both facades.

Additive; no breaking changes.
