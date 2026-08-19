---
"@versioned-store/core": minor
---

`createPostgresBackend(pool, opts?)` now accepts optional table names.

`createPostgresBackend(pool, { versionsTable, labelsTable })` lets several stores share one Postgres database without colliding, the same way the Mongo backend takes collection names and the Redis backend takes a prefix. Names are validated as strict SQL identifiers and double-quoted, so a name cannot inject SQL. The default is unchanged (`versions` / `labels`, quoted lowercase, identical to the historical unquoted tables), so existing deployments are unaffected.

This also unblocks the live-backend conformance run (beta.0 gate #4): each factory call can namespace to its own scratch tables on a real Postgres server, which the mock (single-event-loop) conformance cannot exercise for the multi-connection CAS race.
