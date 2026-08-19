// Portable resolve-latency benchmark. Plain ESM JavaScript, ZERO install: it imports the built core from a
// sibling `dist/` and uses only node: builtins, because the core itself has no runtime dependencies. Copy the
// packed folder to any machine with Node and run `node portable.mjs`. No npm, no tsx, no toolchain.
//
// This is the multi-device counterpart to bench/run.ts (which runs from source inside the workspace). Same
// measurements, but it travels: a phone under Termux, a spare laptop, a server. The point of running it on
// constrained hardware is that "embedded-first" is a claim about where this can live, so the interesting
// number is not the fastest machine's, it is the slowest one's.
//
// Output: a human table on stdout, plus result.json (machine-readable) for merging device runs into one
// matrix. Iteration counts AUTO-CALIBRATE, so a slow phone and a fast laptop both finish in about the same
// wall time rather than the phone running for an hour.
//
// Usage:
//   node portable.mjs                 # normal run
//   node portable.mjs --quick         # fewer iterations (a smoke)
//   node portable.mjs --label "Pixel 8 / Termux"   # name this device in the output

import os from "node:os";
import { hrtime } from "node:process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const labelIdx = args.indexOf("--label");
const LABEL = labelIdx >= 0 ? args[labelIdx + 1] : "";

// ── Load the core from the sibling dist ────────────────────────────────────
const core = await import("./dist/index.js");
const { createVersionedStore, createInMemoryBackend, createFileBackend } = core;

// SQLite is a subpath and needs node:sqlite (Node 22+). Absent on older Node, which is a supported
// configuration, not a failure: the main entry is Node 18 safe by design. Skip it and say so.
let createSqliteBackend = null;
try {
  ({ createSqliteBackend } = await import("./dist/backends/sqlite.js"));
} catch {
  createSqliteBackend = null;
}

// ── Device identification ──────────────────────────────────────────────────
function deviceInfo() {
  const cpus = os.cpus();
  // Termux reports platform "android" on current Node; older builds report "linux" with a telltale PREFIX.
  const isAndroid = os.platform() === "android" || (process.env.PREFIX ?? "").includes("com.termux");
  return {
    label: LABEL || os.hostname(),
    platform: isAndroid ? "android (termux)" : os.platform(),
    arch: os.arch(),
    release: os.release(),
    node: process.version,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    // A phone's reported clock is frequently meaningless (it is whatever the governor was doing at import),
    // so it is recorded but should not be compared across devices.
    cpuSpeedMHz: cpus[0]?.speed ?? 0,
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    quick: QUICK,
    startedAt: new Date().toISOString(),
  };
}

// ── Store config ───────────────────────────────────────────────────────────
const cfg = () => ({
  domain: "bench",
  defaults: {},
  hash: (v) => createHash("sha256").update(v.text).digest("hex"),
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
});

// ── Timing ─────────────────────────────────────────────────────────────────
function stat(ns) {
  const s = [...ns].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const us = (v) => Math.round((v / 1000) * 100) / 100;
  return {
    p50: us(at(50)),
    p95: us(at(95)),
    p99: us(at(99)),
    mean: us(s.reduce((a, b) => a + b, 0) / s.length),
    n: s.length,
  };
}

/**
 * Calibrate then measure. A fixed iteration count is wrong across a 100x hardware range: it either finishes
 * instantly on a laptop (too few samples to be meaningful) or runs for an hour on a phone. So time a short
 * probe, then pick a count that targets a fixed WALL TIME, clamped so the sample is neither trivial nor huge.
 */
async function measure(op, targetMs) {
  for (let i = 0; i < 20; i++) await op(i); // warm the JIT and any lazy init

  const probeStart = hrtime.bigint();
  let probe = 0;
  while (Number(hrtime.bigint() - probeStart) / 1e6 < 25 && probe < 2000) {
    await op(probe++);
  }
  const perOpMs = Number(hrtime.bigint() - probeStart) / 1e6 / Math.max(1, probe);
  const want = Math.round(targetMs / Math.max(perOpMs, 0.0001));
  const iters = Math.max(50, Math.min(QUICK ? 500 : 20000, want));

  const samples = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = hrtime.bigint();
    await op(i);
    samples[i] = Number(hrtime.bigint() - t0);
  }
  return stat(samples);
}

// ── One backend x one payload size ─────────────────────────────────────────
async function benchOne(name, make, sizeName, bytes) {
  const payload = { text: "x".repeat(bytes) };
  const backend = make();
  const store = createVersionedStore(cfg(), backend);
  await store.ensureIndexes();

  const SEED = QUICK ? 40 : 150;
  const target = QUICK ? 150 : 700; // ms of measured wall time per operation

  for (let i = 0; i < SEED; i++) {
    const v = await store.addVersion(`k${i}`, payload);
    await store.promote(`k${i}`, v);
  }

  await store.resolve("k0");
  const warm = await measure(async () => {
    await store.resolve("k0");
  }, target);

  // A fresh store over the same backend has an empty version cache, so each key's first touch is a cold read.
  const coldStore = createVersionedStore(cfg(), backend);
  const coldSamples = [];
  for (let i = 0; i < SEED; i++) {
    const t0 = hrtime.bigint();
    await coldStore.resolve(`k${i}`);
    coldSamples.push(Number(hrtime.bigint() - t0));
  }
  const cold = stat(coldSamples);

  const promote = await measure(async () => {
    await store.promote("k0", 1);
  }, target);

  let addCounter = 0;
  const add = await measure(async () => {
    await store.addVersion("addkey", payload);
    addCounter++;
  }, target);

  return { backend: name, size: sizeName, warmResolve: warm, coldResolve: cold, promote, addVersion: add };
}

// ── Main ───────────────────────────────────────────────────────────────────
const device = deviceInfo();
const backends = [
  ["InMemory", () => createInMemoryBackend()],
  ["File", () => createFileBackend(mkdtempSync(join(tmpdir(), "vsbench-")))],
];
if (createSqliteBackend) backends.splice(1, 0, ["SQLite (:memory:)", () => createSqliteBackend(":memory:")]);

const sizes = [
  ["small (16 B)", 16],
  ["large (20 KB)", 20000],
];

console.log(`\nversioned-store portable benchmark`);
console.log(`device : ${device.label}`);
console.log(`system : ${device.platform}/${device.arch}, ${device.cpu} x${device.cpuCount}, ${device.totalMemGB} GB, node ${device.node}`);
if (!createSqliteBackend) {
  console.log(`note   : node:sqlite unavailable (needs Node 22+), so the SQLite backend is skipped on this device`);
}
console.log(QUICK ? `mode   : QUICK (smoke, not publishable)\n` : `mode   : full\n`);

const results = [];
for (const [name, make] of backends) {
  for (const [sizeName, bytes] of sizes) {
    process.stdout.write(`  measuring ${name} / ${sizeName} ... `);
    const r = await benchOne(name, make, sizeName, bytes);
    results.push(r);
    console.log(`warm p50 ${r.warmResolve.p50} us`);
  }
}

const f = (s) => `${s.p50} / ${s.p95} / ${s.p99}`;
const rows = [
  "",
  "| backend | payload | warm resolve | cold resolve | promote | addVersion |",
  "|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.backend} | ${r.size} | ${f(r.warmResolve)} | ${f(r.coldResolve)} | ${f(r.promote)} | ${f(r.addVersion)} |`),
  "",
  "microseconds, p50 / p95 / p99",
  "",
];
console.log(rows.join("\n"));

writeFileSync("result.json", JSON.stringify({ device, results }, null, 2), "utf8");
console.log(`wrote result.json (send this back to merge into the device matrix)\n`);
