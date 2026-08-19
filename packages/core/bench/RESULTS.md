# versioned-store resolve-latency benchmark

The BENCHMARK half of TD-VS-01. Latencies are microseconds (µs), reported as **p50 / p95 / p99 / mean**.

## Environment

- date: 2026-08-19T10:07:38.067Z
- node: v24.11.1
- os: Windows_NT 10.0.22621 (x64)
- cpu: 12th Gen Intel(R) Core(TM) i7-1270P x 16
- mode: full
- source: run against src via tsx (publishable numbers should use the built dist on fixed hardware)

> These numbers are from a developer machine, not fixed hardware, and are a relative baseline. The beta gate calls for an environment-stamped run of the built dist on fixed hardware; treat this as the harness output to be superseded by that run.

## Results (µs: p50 / p95 / p99 / mean)

| backend | payload | warm resolve | cold resolve | promote | addVersion | 50x concurrent add, distinct keys (ms) |
|---|---|---|---|---|---|---|
| InMemory | small (16 B) | 3.6 / 5.7 / 6.2 / 4.25 | 7.3 / 8.6 / 12.2 / 6.76 | 9.7 / 14.5 / 49.1 / 11.66 | 12.6 / 17.2 / 57.4 / 15.92 | 0.647 |
| InMemory | large (20 KB) | 3.7 / 6.2 / 17.4 / 5.37 | 12.3 / 25.4 / 31 / 21.88 | 17.1 / 33.8 / 118.1 / 24.34 | 55.9 / 71.5 / 135.8 / 58.89 | 2.837 |
| SQLite (:memory:) | small (16 B) | 10 / 22 / 71.6 / 12.64 | 20.8 / 34.4 / 148.6 / 21.93 | 27.1 / 110.5 / 213.3 / 38.32 | 28.6 / 74.1 / 204.2 / 36.98 | 1.617 |
| SQLite (:memory:) | large (20 KB) | 10 / 25.7 / 117.8 / 13.85 | 54.8 / 87.1 / 164.9 / 47.33 | 105.8 / 243.7 / 405.8 / 124.89 | 132.1 / 289.5 / 428.1 / 156.82 | 7.029 |
| File | small (16 B) | 176.3 / 460.3 / 640.3 / 225.89 | 341.3 / 736.3 / 1080.8 / 357.7 | 863.2 / 1681.9 / 2282.2 / 972.64 | 1881.7 / 2957.2 / 3467.5 / 1979.73 | 19.288 |
| File | large (20 KB) | 327.9 / 690.4 / 846.9 / 374.35 | 767.1 / 1731 / 2176.7 / 896.41 | 1136.2 / 2115.2 / 2502.8 / 1264.58 | 2140.9 / 3183.9 / 3818.4 / 2225.77 | 20.786 |

## What to read from this

- **warm resolve** is the hot path (an active prompt resolved once per workflow, or a config read). It is one label read plus a version-cache hit; on the embedded backends it is at Map / syscall cost. This is the embedded-first claim, as a number.
- **cold resolve** (a key's first touch) pays the label read plus one version read; every subsequent resolve of that key is warm.
- **promote** is the deploy path (a label upsert); **addVersion** is an immutable insert plus the content hash.
- Networked backends (Postgres/Mongo/Redis) are not in this run; add them by pointing the harness at a live server, where the warm-resolve number becomes exactly one round-trip rather than a full re-read.
