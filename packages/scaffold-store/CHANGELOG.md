# @versioned-store/scaffold-store

## 0.1.0-alpha.4

### Minor Changes

- Thread the full promote surface through both facades.

  `createPromptStore` and `createScaffoldStore` build the core store by PICKING config fields, so the promote-path additions from `@versioned-store/core@0.1.0-alpha.3` were reachable only by calling `createVersionedStore` directly, never through the facade. Since the facade is the high-traffic surface (all the promote traffic goes through it), promotion audit and history were effectively impossible for a facade consumer. Both facades now pass the surface through:

  - **`onEvent`:** a new `onEvent?(event)` option on `PromptStoreOptions` / `ScaffoldStoreOptions`, forwarded to the core. A host can now persist an at-source audit trail of promotions through the facade, which is what makes promotion history queryable.
  - **`note` + `refs` on `promote`:** both facade `promote` methods now accept `note` and `refs` and forward them, so they persist on the label and ride the `promote-accepted` event.
  - **`revertToCodeDefault(key)`:** the ungated single-key kill-switch is now exposed on both facades.

  Additive; no breaking changes.

### Patch Changes

- Updated dependencies
  - @versioned-store/core@0.1.0-alpha.4

## 0.1.0-alpha.0

### Minor Changes

- 0b584c7: First alpha of the versioned-store workspace.

  `@versioned-store/core` is the generic primitive: immutable versions of an arbitrary payload `T`, a movable label pointer, a code-default fallback, and an eval-gate coupled to promote, over an eight-method backend contract. Six backends ship (InMemory, SQLite, File, Postgres, Redis, Mongo), all certified by the same exported conformance suite, plus migration, sealed portable bundles, canary/shadow with gate-driven auto-rollback, a versioned event schema, an error taxonomy, and a CLI.

  `@versioned-store/prompt-store` and `@versioned-store/scaffold-store` are batteries-included domain stores on that core: strict placeholder rendering with a golden-render promote-gate for prompts, and pinning plus placeholder-binding plus an executable allowlist for scaffolds.

  The main entry of every package is dependency-free and Node 18 safe; anything that needs a driver (`node:sqlite`, `pg`, `mongodb`) is a subpath export.

### Patch Changes

- Updated dependencies [0b584c7]
  - @versioned-store/core@0.1.0-alpha.0
