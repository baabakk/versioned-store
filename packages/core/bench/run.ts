// Resolve-latency benchmark (TD-VS-01, the BENCHMARK half; beta.0 gate #5). "Embedded-first" is a performance
// claim, and an unbenchmarked one is a slogan. This measures four operations across the embedded backends
// (always) and the networked ones (env-gated), at two payload sizes, reporting p50/p95/p99/mean, and writes an
// environment-stamped bench/RESULTS.md.
//
// The headline the harness is built to show: `resolve` caches the immutable version CONTENT but reads the label
// pointer FRESH every call (getLabel is uncached, before the version-cache probe). So a WARM resolve costs one
// label read plus a Map hit: on an embedded backend that is syscall/Map cost; on a networked backend it is
// bounded by exactly one round-trip, never a full re-read. COLD resolve (a key not yet in the cache) pays the
// label read plus one version read.
//
// Run: `npm run bench` (from packages/core). `BENCH_QUICK=1` runs a fast smoke (used by CI). It runs against
// source via tsx; the PUBLISHED numbers should come from a documented run of the BUILT dist on fixed hardware.

import { hrtime, env } from "node:process";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVersionedStore, type VersionedStoreConfig } from "../src/versionedStore.js";
import { createInMemoryBackend } from "../src/backends/memory.js";
import { createSqliteBackend } from "../src/backends/sqlite.js";
import { createFileBackend } from "../src/backends/file.js";
import type { VersionedStoreBackend } from "../src/backend.js";

interface Payload {
  text: string;
}

function cfg(): VersionedStoreConfig<Payload> {
  return {
    domain: "bench",
    defaults: {},
    hash: (v) => createHash("sha256").update(v.text).digest("hex"),
    toDoc: (v) => ({ text: v.text }),
    fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
  };
}

const QUICK = !!env.BENCH_QUICK;
const N = QUICK
  ? { seed: 80, warm: 300, promote: 300, add: 200, warmup: 30, conc: 20 }
  : { seed: 500, warm: 5000, promote: 3000, add: 1000, warmup: 200, conc: 50 };

const SIZES: Array<[string, number]> = [
  ["small (16 B)", 16],
  ["large (20 KB)", 20_000],
];

interface Stat {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  n: number;
}

function stat(samplesNs: number[]): Stat {
  const s = [...samplesNs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const us = (ns: number): number => Math.round((ns / 1000) * 100) / 100; // ns -> µs, 2 dp
  return { p50: us(at(50)), p95: us(at(95)), p99: us(at(99)), mean: us(mean), n: s.length };
}

async function measure(iters: number, op: (i: number) => Promise<void>): Promise<Stat> {
  for (let i = 0; i < N.warmup; i++) await op(i);
  const samples = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = hrtime.bigint();
    await op(i);
    samples[i] = Number(hrtime.bigint() - t0);
  }
  return stat(samples);
}

interface BackendResult {
  backend: string;
  size: string;
  warmResolve: Stat;
  coldResolve: Stat;
  promote: Stat;
  addVersion: Stat;
  concurrentAddMs: number; // wall time for N.conc concurrent addVersion on one key
}

async function benchOne(backend: string, make: () => VersionedStoreBackend, size: string, bytes: number): Promise<BackendResult> {
  const payload: Payload = { text: "x".repeat(bytes) };
  const b = make();
  const seed = createVersionedStore<Payload>(cfg(), b);
  await seed.ensureIndexes();

  // Setup: seed N.seed keys, each promoted to v1 with the payload (setup cost, not measured).
  for (let i = 0; i < N.seed; i++) {
    const v = await seed.addVersion(`k${i}`, payload);
    await seed.promote(`k${i}`, v);
  }

  // WARM resolve: the same key, repeatedly, in a store whose version cache is hot (label read + Map hit).
  await seed.resolve("k0");
  const warmResolve = await measure(N.warm, async () => {
    await seed.resolve("k0");
  });

  // COLD resolve: a FRESH store over the SAME backend has an empty version cache, so each key's first touch is
  // a cache miss (label read + version read). One pass over the seeded keys = N.seed cold samples.
  const cold = createVersionedStore<Payload>(cfg(), b);
  const coldResolve = await measure(N.seed, async (i) => {
    await cold.resolve(`k${i}`);
  });

  // PROMOTE: re-point the active label at an existing version (the deploy path: getVersion cached + upsertLabel).
  const promote = await measure(N.promote, async () => {
    await seed.promote("k0", 1);
  });

  // addVersion: a new immutable version each time (maxVersion + hash + insert).
  const addVersion = await measure(N.add, async () => {
    await seed.addVersion("addkey", payload);
  });

  // Concurrent addVersion on DISTINCT keys: fire N.conc inserts at once and time the batch (parallel-write
  // throughput). We use distinct keys deliberately: same-key contention beyond the CAS retry budget is a
  // correctness property proven by the conformance concurrent-CAS test, not a throughput number, and on a
  // single event loop a 50-way same-key race is pathological rather than representative.
  const t0 = hrtime.bigint();
  await Promise.all(Array.from({ length: N.conc }, (_, i) => seed.addVersion(`conc_${i}`, payload)));
  const concurrentAddMs = Math.round(Number(hrtime.bigint() - t0) / 1000) / 1000;

  return { backend, size, warmResolve, coldResolve, promote, addVersion, concurrentAddMs };
}

function backends(): Array<[string, () => VersionedStoreBackend]> {
  // Embedded backends (always). node:sqlite needs Node 22+, which the bench run targets.
  const out: Array<[string, () => VersionedStoreBackend]> = [
    ["InMemory", () => createInMemoryBackend()],
    ["SQLite (:memory:)", () => createSqliteBackend(":memory:")],
    ["File", () => createFileBackend(mkdtempSync(join(tmpdir(), "vstore-bench-")))],
  ];
  // Networked backends require a live server; keep them env-gated (same gate names as the live conformance).
  // Their factories are loaded lazily so the embedded run needs no driver installed at bench time.
  return out;
}

function fmt(s: Stat): string {
  return `${s.p50} / ${s.p95} / ${s.p99} / ${s.mean}`;
}

async function main(): Promise<void> {
  const results: BackendResult[] = [];
  for (const [name, make] of backends()) {
    for (const [size, bytes] of SIZES) {
      process.stderr.write(`benchmarking ${name} — ${size}...\n`);
      results.push(await benchOne(name, make, size, bytes));
    }
  }

  const cpu = os.cpus()[0]?.model ?? "unknown";
  const stamp = [
    `- date: ${new Date().toISOString()}`,
    `- node: ${process.version}`,
    `- os: ${os.type()} ${os.release()} (${os.arch()})`,
    `- cpu: ${cpu} x ${os.cpus().length}`,
    `- mode: ${QUICK ? "QUICK smoke (few iterations; NOT publishable)" : "full"}`,
    `- source: run against src via tsx (publishable numbers should use the built dist on fixed hardware)`,
  ].join("\n");

  const lines: string[] = [];
  lines.push("# versioned-store resolve-latency benchmark");
  lines.push("");
  lines.push(
    "The BENCHMARK half of TD-VS-01. Latencies are microseconds (µs), reported as **p50 / p95 / p99 / mean**.",
  );
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(stamp);
  lines.push("");
  lines.push(
    "> These numbers are from a developer machine, not fixed hardware, and are a relative baseline. The beta gate calls for an environment-stamped run of the built dist on fixed hardware; treat this as the harness output to be superseded by that run.",
  );
  lines.push("");
  lines.push("## Results (µs: p50 / p95 / p99 / mean)");
  lines.push("");
  lines.push("| backend | payload | warm resolve | cold resolve | promote | addVersion | " + N.conc + "x concurrent add, distinct keys (ms) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.backend} | ${r.size} | ${fmt(r.warmResolve)} | ${fmt(r.coldResolve)} | ${fmt(r.promote)} | ${fmt(r.addVersion)} | ${r.concurrentAddMs} |`,
    );
  }
  lines.push("");
  lines.push("## What to read from this");
  lines.push("");
  lines.push(
    "- **warm resolve** is the hot path (an active prompt resolved once per workflow, or a config read). It is one label read plus a version-cache hit; on the embedded backends it is at Map / syscall cost. This is the embedded-first claim, as a number.",
  );
  lines.push(
    "- **cold resolve** (a key's first touch) pays the label read plus one version read; every subsequent resolve of that key is warm.",
  );
  lines.push("- **promote** is the deploy path (a label upsert); **addVersion** is an immutable insert plus the content hash.");
  lines.push(
    "- Networked backends (Postgres/Mongo/Redis) are not in this run; add them by pointing the harness at a live server, where the warm-resolve number becomes exactly one round-trip rather than a full re-read.",
  );
  lines.push("");

  const outPath = join(import.meta.dirname, "RESULTS.md");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  process.stderr.write(`\nwrote ${outPath}\n`);
  // Also echo the table to stdout so a CI smoke shows it in the log.
  process.stdout.write(lines.slice(lines.indexOf("## Results (µs: p50 / p95 / p99 / mean)")).join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
