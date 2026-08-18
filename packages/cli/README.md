# @versioned-store/cli

A descriptor-driven operator surface for [`@versioned-store`](https://github.com/baabakk/versioned-store) stores. One uniform verb set over every store domain, so no consumer hand-rolls an admin surface (and no consumer forgets to wire one).

```
npm install @versioned-store/cli
```

## Why

A store is only as operable as its admin surface, and that surface is otherwise re-hand-rolled per domain, per app. Two failure modes come from that, both found in a real rollback rehearsal:

1. A hand-rolled surface silently drops a payload family. A store whose revert verb was never wired is only discovered during an incident, when an operator runs a runbook command that turns out not to cover that store.
2. The audit sink loses writes on a short-lived process. `onEvent` is synchronous, so a sink that persists to a networked store detaches its write; a CLI closes the backend the instant the verb returns, and the detached write loses its session. The audit row is never written.

This package removes both. You hand it one descriptor per store domain; it drives the verbs.

## Guarantees

- **Gated promote, by construction.** The descriptor exposes only the domain's *gated* promote; the raw ungated `promote(gate?)` is `Omit`-ed off the store surface, so an ungated promote is unreachable through the CLI.
- **`health` covers every registered domain.** It runs `checkDefaults` across all of them and exits non-zero if any domain has an unhealthy code default. A domain is either registered (and covered) or absent (nothing to operate); it cannot be half-wired.
- **The runner owns the audit-sink drain.** The lifecycle is connect then verb then drain then close, so a promote's audit row lands before the process exits. Wire the sink with [`createDrainableSink`](https://github.com/baabakk/versioned-store/tree/main/packages/core).

## Usage

Build one descriptor per domain from that domain's facade (its `.core`, its gated `promote`, its zero-arg `checkDefaults`), then run:

```ts
import { createStoreCli, makeDescriptor } from "@versioned-store/cli";
import { createDrainableSink } from "@versioned-store/core";

// Each store already exists in your composition root. Wire its audit sink drainably:
const promptSink = createDrainableSink(async (e) => { await audit.insert(e); });
// ...pass promptSink.onEvent as the store's onEvent at construction...

const cli = createStoreCli({
  commands: [
    makeDescriptor({
      domain: "prompt",
      store: promptStore.core,               // read + admin verbs (ungated promote is not on this type)
      promote: promptStore.promote,          // the GATED promote
      checkDefaults: () => promptStore.checkDefaults(),
      parsePayload: (raw) => ({ text: raw }),
      drain: () => promptSink.drain(),
    }),
    makeDescriptor({
      domain: "config",
      store: configStore.core,
      promote: configStore.promote,
      checkDefaults: () => configStore.checkDefaults(),
      parsePayload: (raw) => JSON.parse(raw),
      drain: () => configSink.drain(),
    }),
  ],
  connect: async () => { await openBackend(); },
  close: async () => { await closeBackend(); },
  actor: () => process.env.USER ?? "store-admin",
});

process.exit(await cli.run(process.argv.slice(2)));
```

## Verbs

| Verb | What it does | Scope |
|---|---|---|
| `list [key]` | List keys, or the versions of one key. | all domains, or one |
| `add <key> <payload>` | Add a new INACTIVE version parsed from `<payload>`. | one domain |
| `promote <key> <version> [note]` | Move the active label to a version. Refused if it fails its eval-gate. | one domain |
| `revert <key>` | Kill-switch: re-promote the in-code default, ungated by design. | one domain |
| `diff <key>` | Compare the active version to the in-code default. | one domain |
| `seed` | Insert any unseeded code defaults (idempotent). | all domains, or one |
| `sync` | Add and promote any code default whose content drifted from active. | all domains, or one |
| `health` | Run every code default through its gate; exit 1 if any domain is unhealthy. | all domains, or one |

A key-targeted verb needs `--domain <name>` when more than one domain is registered (with a single domain it is inferred). Pass `--by <actor>` to attribute a write. `run` returns an exit code and never throws: 0 on success, 1 on a runtime failure (a refused promote, a missing version), 2 on a usage error.

## License

MIT
