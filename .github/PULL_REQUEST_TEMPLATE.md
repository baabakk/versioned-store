<!-- For a non-trivial change, open an issue first so we agree on the shape (see CONTRIBUTING.md). -->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Checklist

- [ ] Tests added or updated for the change (a new backend must pass `runConformance`).
- [ ] `npm test` passes workspace-wide.
- [ ] `npm run build` is clean.
- [ ] A changeset is included if a published package changed (`npm run changeset`).
- [ ] Docs updated if behavior or the public API changed (READMEs describe verified behavior, not aspirational).
- [ ] The architecture rules hold: no policy in a backend, no domain branch in the core, no driver import in a main entry.
