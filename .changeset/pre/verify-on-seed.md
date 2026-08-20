---
"@versioned-store/core": minor
"@versioned-store/prompt-store": minor
"@versioned-store/scaffold-store": minor
"@versioned-store/cli": minor
---

verify-on-seed: `seedDefaults` and `syncDefaults` can now refuse an unsound code default instead of promoting it to active.

Seed and sync promote the code default to the ACTIVE version, so a default that could not pass its own gate would be made active unvalidated. That is the "seed hole" `checkDefaults` was added to detect; this closes it on the write side.

- **core:** `seedDefaults(opts?)` and `syncDefaults(opts?)` accept an optional `{ gate: DefaultsGate<T> }`. When a gate is supplied, each default is verified before it is promoted; a default the gate rejects is skipped and reported (`seedDefaults` returns `{ key, seeded: false, refused: true, failures }`; `syncDefaults` returns `{ key, action: "refused", failures }`). Seed/sync never throw on an unsound default, so one bad default cannot halt the run. New exported types `SeedResult`, `SyncResult`. Without a gate, behavior is unchanged (every default is seeded).
- **prompt-store / scaffold-store:** their `seedDefaults` (and scaffold-store's `syncDefaults`) now ALWAYS auto-inject the same gate `promote` uses, so a facade consumer's boot seed cannot make an unsound default active. This is a behavior change for a consumer that ships an unsound default: it is now refused rather than promoted. Inspect the returned report; the policy on a refused default (fail boot, warn) stays the consumer's.
- **cli:** a descriptor may carry an optional `gate`; when present, the `seed` and `sync` verbs verify each default and report refusals, and the verb exits non-zero if any default was refused, so an operator or CI step fails loudly.

The refused default is still SERVED via the fallback path (the sentinel v0), which the consumer guards at boot with `checkDefaults`. Additive API; the behavior change only affects a store that ships a default its own gate rejects.
