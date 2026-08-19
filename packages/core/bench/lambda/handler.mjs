// The benchmark, as an AWS Lambda handler.
//
// This is the measurement that matters most for the "embedded-first" claim. A hosted config service (AWS
// AppConfig, SSM Parameter Store) resolves over the network; this store resolves from memory or from the
// local filesystem, so in a Lambda it costs microseconds and, critically, costs NOTHING at cold start
// because the code default is compiled into the bundle. There is no fetch to wait for and no failure mode
// where config is unreachable and the function cannot start.
//
// Module scope runs during Lambda INIT (the cold start). Everything here is therefore part of what a cold
// invocation pays, which is exactly what we want to measure.

import { createVersionedStore, createInMemoryBackend, createFileBackend } from "@versioned-store/core";

const initStart = process.hrtime.bigint();

const cfg = (defaults) => ({
  domain: "bench",
  defaults,
  hash: (v) => v.text,
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
});

// A code default is available IMMEDIATELY, with no I/O of any kind. This is the whole point: a function can
// resolve its configuration before it has talked to anything.
const memStore = createVersionedStore(cfg({ greeting: { text: "hello from the code default" } }), createInMemoryBackend());

// /tmp is the writable filesystem Lambda gives every execution environment (512 MB by default), so the File
// backend is a legitimate deployment shape here: durable for the life of the environment, shared across warm
// invocations, and still requiring no network.
const fileStore = createVersionedStore(cfg({ greeting: { text: "hello from the file backend" } }), createFileBackend("/tmp/vsbench"));

const initNs = Number(process.hrtime.bigint() - initStart);

let firstInvoke = true;
let coldResolveNs = null;

function stat(ns) {
  const s = [...ns].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const us = (v) => Math.round((v / 1000) * 100) / 100;
  return { p50: us(at(50)), p95: us(at(95)), p99: us(at(99)), n: s.length };
}

async function measure(fn, iters) {
  for (let i = 0; i < 50; i++) await fn();
  const out = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    out[i] = Number(process.hrtime.bigint() - t0);
  }
  return stat(out);
}

export const handler = async () => {
  // The very first resolve in a fresh execution environment, measured once. On a code-default resolve this is
  // the honest "cold config read" number, and it involves no network call at all.
  if (firstInvoke) {
    const t0 = process.hrtime.bigint();
    await memStore.resolve("greeting");
    coldResolveNs = Number(process.hrtime.bigint() - t0);
    firstInvoke = false;
  }

  await fileStore.ensureIndexes();
  await fileStore.seedDefaults();

  const memWarm = await measure(() => memStore.resolve("greeting"), 2000);
  const fileWarm = await measure(() => fileStore.resolve("greeting"), 500);

  return {
    arch: process.arch,
    node: process.version,
    memoryMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
    region: process.env.AWS_REGION,
    // Lambda INIT: importing the store and constructing two of them, with zero I/O.
    initMicros: Math.round(initNs / 1000),
    coldFirstResolveMicros: coldResolveNs === null ? null : Math.round((coldResolveNs / 1000) * 100) / 100,
    warmResolveInMemory: memWarm,
    warmResolveFile: fileWarm,
  };
};
