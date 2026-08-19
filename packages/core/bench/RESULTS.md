# versioned-store: resolve-latency benchmark

"Embedded-first" is a performance claim, and an unbenchmarked claim is a slogan. This is the measurement.

All figures are **microseconds**, reported as **p50 / p95** unless noted. Every cloud row ran the SAME script
(`bench/portable.mjs`) against the **published npm package** `@versioned-store/core@0.1.0-alpha.5`, not a local
build, so what is measured is what a consumer installs.

## What is being measured

| Operation | What it does | Why it matters |
|---|---|---|
| **warm resolve** | resolve a key whose version this process has already seen | the hot path: a config read, or a prompt resolved per request |
| **cold resolve** | the first touch of a key in a fresh process | what a new worker or a new deployment pays, once per key |
| **promote** | move the `active` label to an existing version | the deploy path |
| **addVersion** | insert a new immutable version | the authoring path |

A warm resolve is one label read plus a version-cache hit. Version content is immutable so it is cached
forever; the label pointer is read fresh every time, which is what lets a promote take effect immediately
across processes with no invalidation protocol. That design is why the warm number stays flat as the payload
grows from 16 bytes to 20 KB.

## Results: warm resolve p50 (16 B payload)

| Environment | CPU | InMemory | SQLite | File |
|---|---|---|---|---|
| AWS Lambda, arm64, 1024 MB | Graviton (Lambda) | **0.98** | n/a | 89.29 |
| AWS Lambda, x86_64, 1024 MB | (Lambda) | 1.48 | n/a | 118.12 |
| AWS EC2 `c7a.large` | AMD EPYC 9R14 (Genoa) | **1.93** | 5.31 | 82.87 |
| Hetzner `CCX13` (dedicated vCPU) | AMD EPYC Milan | 1.97 | 5.46 | 145.42 |
| AWS EC2 `c7g.large` | Graviton3 | 2.67 | 8.11 | 69.27 |
| AWS EC2 `c7i.large` | Intel Xeon Platinum 8488C (Sapphire Rapids) | 3.55 | 9.01 | 57.95 |
| Hetzner `CX23` (shared vCPU) | Intel Xeon Skylake | 3.78 | 18.54 | 241.42 |
| **Android phone, Termux, Node 26** | **Snapdragon 8+ Gen 1** | **10.21** | 23.44 | 144.32 |
| Laptop, Windows 11 (see caveat) | Intel i7-1270P | 13.0 | 26.5 | 673.7 |

SQLite is not listed for Lambda because that run measured the two backends a Lambda would realistically use:
in-memory, and File on `/tmp`.

## The phone, which is the clearest statement of "embedded-first"

A configuration store that needs a server cannot run here at all. This one resolves a versioned, gated,
rollback-capable configuration in **10.21 µs on a handset**, with a full percentile spread of
`10.21 / 11.46 / 17.92` (p50 / p95 / p99):

| backend | warm resolve | cold resolve | promote |
|---|---|---|---|
| InMemory | 10.21 / 11.46 / 17.92 | 21.61 / 34.58 / 83.49 | 22.86 / 23.85 / 40.78 |
| SQLite (`:memory:`) | 23.44 / 29.95 / 44.90 | 51.20 / 58.86 / 117.29 | 57.86 / 69.69 / 103.80 |
| File | 144.32 / 761.56 / 905.11 | 296.93 / 423.23 / 495.47 | 339.64 / 373.07 / 422.34 |

The handset is a **Snapdragon 8+ Gen 1** (SM8475, TSMC 4nm): one Cortex-X2 prime core at 3.2 GHz, three
Cortex-A710 at 2.75 GHz, and four Cortex-A510 efficiency cores at 1.8 GHz. That tri-cluster layout matters for
reading the row: the tight spread (a p99 of 17.92 µs against a p50 of 10.21 µs) says the scheduler kept the
process on the prime or performance cores for the whole run. A migration onto an A510 mid-run would have
widened the tail sharply, so this row represents the phone behaving well, not the phone at its worst.

Two observations worth drawing out.

The phone is **faster and more consistent than the Windows laptop** in this table (10.21 µs against 13.0 µs,
with a p99 of 17.92 µs against 112.9 µs). That is not a claim that the handset has a faster CPU. It is a
demonstration that at microsecond scale, what a machine is *doing* dominates what a machine *is*, which is the
single most important caveat when reading any row here.

And the same package, unmodified, ran on Lambda, on three EC2 instance families, on two Hetzner types, on a
Windows laptop, and on an Android phone, from one npm install with no native build step. That portability is
the design goal the zero-dependency core exists to serve, and this row is the proof of it.

## The serverless number, which is the point

AWS Lambda, `nodejs22.x`, 1024 MB, us-west-2:

| arch | init | cold first resolve | warm resolve p50 / p95 |
|---|---|---|---|
| arm64 | 254 µs | **338.88 µs** | 0.98 / 1.37 |
| x86_64 | 283 µs | 369.17 µs | 1.48 / 1.79 |

"Init" is Lambda's cold start: importing the store and constructing two of them. "Cold first resolve" is the
first configuration read in a brand new execution environment.

The number that matters is that a cold Lambda is **configured in roughly a third of a millisecond, having made
no network call at all**. The code default is compiled into the bundle, so there is no fetch to wait for, no
timeout to tune, and no failure mode where configuration is unreachable and the function cannot start. A
config service that resolves over the network cannot offer that property at any latency, because the
difference is not speed, it is whether a dependency exists.

## Same-generation silicon comparison

`c7i` (Intel Sapphire Rapids), `c7a` (AMD Genoa), and `c7g` (Graviton3) are the same generation, the same size
class, and the same region, so the vendor is the only variable:

| instance | CPU | InMemory p50 | relative |
|---|---|---|---|
| `c7a.large` | AMD EPYC 9R14 | 1.93 | 1.00x |
| `c7g.large` | Graviton3 | 2.67 | 1.38x |
| `c7i.large` | Intel Xeon Platinum 8488C | 3.55 | 1.84x |

AMD is roughly 1.8x faster than Intel here. A useful consistency check on the harness: the two Intel rows
(`c7i` at 3.55 and Hetzner's Skylake at 3.78) land within 6% of each other across seven years of silicon and
two different providers, which is what you would expect from a workload this dominated by memory access
patterns rather than clock.

## Reproducing this

Every row is reproducible, which is the reason the cloud rows exist at all. A number from a machine nobody
else can rent is not evidence.

```bash
# any machine with Node 18+ (22+ includes the SQLite backend)
mkdir vsbench && cd vsbench
echo '{"type":"module"}' > package.json
npm i @versioned-store/core@0.1.0-alpha.5
curl -fsSL https://raw.githubusercontent.com/baabakk/versioned-store/main/packages/core/bench/portable.mjs -o portable.mjs
node portable.mjs --label "<name>"
```

The repo also carries the automation used for the rows above, each of which creates instances, benchmarks
them, and destroys everything in a `finally` block: `bench/ec2.mjs`, `bench/hetzner.mjs`, and
`bench/lambda/run.mjs`. All are plan-only until passed `--confirm`.

## Caveats, stated plainly

**The laptop row is the noisiest and should not be used for comparison.** It was measured on a machine doing
other work, on a hybrid P-core/E-core mobile CPU that throttles and reschedules across core types mid-run. Its
p99 for InMemory is 112.9 µs against a p50 of 13 µs, and that spread is the machine, not the library. It is
included precisely because it shows what an uncontrolled environment does to a microsecond-scale measurement,
which is the reason the published numbers come from documented cloud instances instead.

**Iteration counts auto-calibrate to a target wall time.** A fixed count would either finish instantly on a
fast machine, giving too few samples to be meaningful, or run for an hour on a slow one. Sample sizes are
recorded in each run's `result.json`.

**The File backend numbers reflect the filesystem, not just the CPU**, and are the most environment-sensitive
figures here: they span 58 µs on EC2 to 674 µs on a Windows laptop with real-time virus scanning active.

**The phone row was a single run on a device that throttles.** Its tail is expected to widen on a longer or hotter run; the numbers here were taken on a cool device.

**These are single runs, not averaged across repeated trials.** They establish an order of magnitude and the
relative ordering, which is what the "embedded-first" claim needs. They are not a basis for asserting a 5%
difference between two adjacent rows.
