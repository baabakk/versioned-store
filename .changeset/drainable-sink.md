---
"@versioned-store/core": minor
---

Add `createDrainableSink(inner)` — make an async `onEvent` sink flushable before process exit.

`onEvent` is synchronous by contract, so a sink that persists to a networked store must detach its write. That is correct for a long-lived host and wrong for a short-lived one: a CLI closes its backend connection the instant the verb returns, and the detached write loses its session, so the audit row is never written (the `TD-VS-15` failure a downstream consumer hit: an events collection with zero rows).

`createDrainableSink(inner, { onError? })` returns `{ onEvent, drain }`. `inner` does the persistence and returns its promise; the wrapper detaches it (so the store never blocks) but tracks it, and `drain()` awaits every write scheduled so far. A sync throw or async rejection is caught and routed to `onError` (default: a warning), never rethrown, preserving the swallow-and-warn posture (an audit row must never break a kill switch). Wire `onEvent` at store construction and `await drain()` after the verb, before closing the backend.

Additive; zero new dependencies. Foundational for the `@versioned-store/cli` runner's connect → verb → drain → close lifecycle.
