---
"@versioned-store/core": minor
---

Promote-path additions, plus two fixes.

- **`onEvent` sink:** an optional `VersionedStoreConfig.onEvent` hook fires on every store event (`fallback`, `gate-outcome`, `promote-refused`, `promote-accepted`) alongside the injected logger, swallowing sink errors. It captures promotions that bypass wrapper code (scripts, admin routes, the ungated kill-switch), which is what makes a durable promotion-history / audit trail possible.
- **`note` on `promote` and persisted `refs`:** `promote` gains an optional `note`; both `note` and `refs` now persist on the label (previously `refs` was emitted on the event but never stored), and `note` also rides the `promote-accepted` event.
- **`revertToCodeDefault(key)`:** a first-class, ungated single-key kill-switch that adds the in-code default as a new version and promotes it, returning the new version. Prefer it over `syncDefaults()` (which reverts every key) and over `promote(key, 0)` (which now throws a clear `KillSwitchNotSupportedError` pointing at it).
- **Fix (CLI):** the `versioned-store` bin now ships a `#!/usr/bin/env node` shebang, so it runs on Unix (it was broken there in 0.1.0-alpha.0 through alpha.2, masked on Windows).
- **Fix (conformance):** the concurrent-`addVersion` test now creates its indexes, so a backend's compare-and-swap is genuinely certified on Mongo.

All additive or fixes; no breaking changes.
