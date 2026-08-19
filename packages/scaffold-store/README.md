# @versioned-store/scaffold-store

A batteries-included, versioned **scaffold store** built on [`@versioned-store/core`](../core): immutable spec versions, a movable `active` pointer, a code-default fallback, and a **deterministic promote-gate** that refuses an unpinned, unbound, or unknown-executable scaffold so a broken spec sits inactive and never runs.

```bash
npm install @versioned-store/scaffold-store zod
```

## The problem

A scaffold command is a supply-chain decision that usually lives in a string somewhere:

```ts
run(`npm create vite@latest ${dir} -- --template react-ts`);
```

That line has three defects and no way to catch them. `@latest` means today's skeleton differs from yesterday's, so the "same" scaffold is not reproducible. If `dir` is ever empty, it scaffolds into a directory named after nothing. And changing it is a code deploy, with no way to roll back the scaffold without rolling back the app.

This package makes the spec a **versioned artifact** and puts a gate in front of the promote:

```ts
import { createScaffoldStore } from "@versioned-store/scaffold-store";
import { createSqliteBackend } from "@versioned-store/core/backends/sqlite";

const scaffolds = createScaffoldStore({
  backend: createSqliteBackend("./scaffolds.db"),
  defaults: {
    "web.frontend.react-vite": {
      key: "web.frontend.react-vite",
      scaffold: {
        mode: "command",
        command: "npm create vite@9.1.0 {dir} -- --template react-ts --no-interactive",
        placement: "fresh",
        network: true,
      },
      install: "npm install --include=dev",
      build: "tsc -b",
      test: "npm test",
    },
  },
});

const spec = await scaffolds.resolveScaffold("web.frontend.react-vite");
if (spec) run(scaffolds.renderCommand(spec, { dir: "packages/web" }));
```

`resolveScaffold` returns `null` for an unknown key rather than throwing: a missing scaffold is a normal outcome that means "hand-roll this one", not an error.

## The gate

`promote` runs the gate before flipping the label, so a spec that fails is recorded as an immutable version but never becomes active:

```ts
const v2 = await scaffolds.addScaffoldVersion(key, floatingSpec); // recorded
await scaffolds.promote(key, v2);                                  // throws; `active` stays on v1
```

It is fully offline and deterministic:

| Check | Why |
|---|---|
| **Pinning** | A networked `scaffold.command` may not use `@latest`, `@next`, `@canary`, `@beta`, `@rc`, `@dev`, `@nightly`, or `@alpha`. A floating tag produces a different skeleton on every run, which defeats versioning the spec at all. |
| **Placeholder binding** | Every `{placeholder}` in `command` / `install` / `build` / `test` must be one the renderer will bind (default: `{dir}`). An unbound `{dir}` would otherwise reach a shell literally. |
| **Executable allowlist** | `scaffold.command`'s executable must be allowed (default: the mainstream package managers and runtimes). |
| **Mode coherence** | `command` mode needs a command; `handroll` mode must not have one that would never run. |
| **Key agreement** | `spec.key` must match the key it is stored under, or a rename silently misroutes. |
| **Schema** | The spec parses against your schema. |

The allowlist applies **only** to `scaffold.command`. That command runs before the project exists and usually fetches a foreign scaffolder over the network, so what it may invoke is worth constraining. `install` / `build` / `test` run afterwards inside the materialized project against its own devDependencies (`tsc -b`, `vite build`, `jest`), and allowlisting those would mean enumerating every build tool that exists.

Tune it per store:

```ts
createScaffoldStore({ backend, defaults, gate: { allowedExecutables: ["npm"], allowedVars: ["dir", "name"] } });
```

## Routing

Real callers rarely have a key: they have a subsystem, a package, or a manifest entry. The router is injected, because how you map your domain to a scaffold is yours, not this package's:

```ts
const scaffolds = createScaffoldStore<BaseScaffoldSpec, Subsystem>({
  backend,
  defaults,
  keyFor: (s) => (s.appType && s.framework ? `${s.appType}.${s.role}.${s.framework}` : null),
});

const spec = await scaffolds.resolveFor(subsystem); // null = no scaffold, hand-roll it
```

## Domain fields

Extend the base schema with whatever your pipeline needs; the gate keeps enforcing the base contract underneath:

```ts
import { BaseScaffoldSpecSchema, createScaffoldStore } from "@versioned-store/scaffold-store";

const MySpecSchema = BaseScaffoldSpecSchema.extend({
  agentDocs: z.string(),
  packageJsonPatch: z.object({ stripDeps: z.array(z.string()) }).optional(),
});

const scaffolds = createScaffoldStore<z.infer<typeof MySpecSchema>>({ backend, schema: MySpecSchema, defaults });
```

## Audit and rollback

Pass an `onEvent` sink to persist an at-source trail of every promotion, annotate each promote with a `note` and structured `refs`, and keep a single-key kill-switch for a spec that misbehaves in production:

```ts
const scaffolds = createScaffoldStore({
  backend,
  defaults,
  onEvent: (e) => auditLog.append(e), // fallback, gate-outcome, promote-refused, promote-accepted
});

const v = await scaffolds.addScaffoldVersion(key, nextSpec);
await scaffolds.promote(key, v, { by: "sre", note: "bump vite to 9.2.0", refs: { pr: 87 } });
// note + refs persist on the label and ride the promote-accepted event.

// Return one key to its in-code default, ungated (a kill-switch a gate could block is not a kill-switch):
await scaffolds.revertToCodeDefault(key, { by: "sre", note: "9.2.0 scaffold broke CI" });
```

The sink fires alongside the injected logger, and its errors are swallowed, so a failing audit sink never disrupts a promote or a resolve.

## Checking your defaults

A code-default spec is served on every fallback and is what `revertToCodeDefault` re-promotes, so it must be able to pass the same gate a candidate must. `checkDefaults()` runs every default through the store's own promote-gate (pinning + binding + allowlist) and reports whether each could go live, without touching the backend:

```ts
const report = await scaffolds.checkDefaults();
if (!report.ok) {
  // report.results is [{ key, passed, failures }]; the policy (fail at boot, warn) is yours.
}
```

## Encryption at rest

To keep a stored spec confidential at rest, pass a `cipher`. The store encrypts the spec after mapping and decrypts it before use; the content hash and the promote-gate stay over the plaintext, so promotion behavior is unchanged. A zero-dependency AES-256-GCM cipher ships at `@versioned-store/core/cipher`:

```ts
import { createAesGcmCipher } from "@versioned-store/core/cipher";

createScaffoldStore({ backend, defaults, cipher: createAesGcmCipher({ key: myKey }) }); // encryptedFields defaults to ["spec"]
```

This protects the backend at rest, not a live compromised process, and it is not a secrets manager. See [SECURITY.md](../../SECURITY.md).

## API

| Member | Purpose |
|---|---|
| `resolveScaffold(key, label?)` | active spec, or `null` (hand-roll) |
| `resolveFor(input, label?)` | route then resolve, or `null` |
| `keyFor(input)` | the routed key without resolving |
| `renderCommand(spec, vars?)` | strict `{placeholder}` binding; throws on unbound |
| `evalScaffoldVersion(key, spec)` | run the gate without promoting |
| `addScaffoldVersion(key, spec, opts?)` | insert an immutable version |
| `promote(key, version, opts?)` | gated label flip (deploy / rollback); `opts.note` / `opts.refs` annotate it for the audit trail |
| `revertToCodeDefault(key, opts?)` | ungated single-key kill-switch: re-promote the in-code default and return its new version |
| `checkDefaults()` | run every code-default spec through the promote-gate; report `{ ok, results }` (the fallback-soundness check) |
| `listVersions` / `listKeys` / `seedDefaults` / `syncDefaults` / `ensureIndexes` | admin verbs |
| `core` | the underlying `VersionedStore<T>` |

Errors extend the core's `VersionedStoreError` (`ScaffoldRenderError`, `ScaffoldRouteError`), so one `catch` covers the library.

MIT.
