---
"@versioned-store/core": minor
"@versioned-store/prompt-store": minor
"@versioned-store/scaffold-store": minor
---

Add `checkDefaults(gate)` — verify the code defaults are gate-valid (the fallback-soundness check).

A code default is served on every `resolve` fallback AND is the value `revertToCodeDefault` re-promotes, so it must be able to pass the same eval-gate a candidate version must. Nothing enforced that before, and every consumer hand-rolled the loop.

- **Core:** a new `VersionedStore.checkDefaults(gate)` runs a supplied per-key gate over every registered default and returns `{ ok, results: [{ key, passed, failures }] }`. Pure: reads only the in-code defaults, touches no backend, emits no event, never throws. New exported types `DefaultsGate<T>`, `DefaultCheck`, `DefaultsHealthReport`. The gate is `(key, value)` because a domain's gate is per-key.
- **prompt-store / scaffold-store:** a zero-argument `checkDefaults()` that reuses each facade's OWN promote-gate (the placeholder + golden-render gate for prompts; the pinning + binding + allowlist gate for scaffolds), so the check and the promote can never drift.
- The POLICY on an unhealthy default (throw at boot, warn, degrade) stays the consumer's; the library only reports.

Additive; no breaking changes.
