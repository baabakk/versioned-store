// Tests for the M16 error taxonomy + refs pass-through (OSS Release Playbook §4 / §7.3).

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createVersionedStore, type VersionedStoreConfig } from "./versionedStore.js";
import { createInMemoryBackend } from "./backends/memory.js";
import { BackendConflictError } from "./backend.js";
import {
  CasExhaustedError,
  GateRejectedError,
  isVersionedStoreError,
  VersionedStoreError,
  VersionNotFoundError,
} from "./errors.js";
import { noopLogger, setStoreLogger, type Logger } from "./logger.js";
import { resetStoreEventCounts } from "./events.js";

const cfg: VersionedStoreConfig<{ text: string }> = {
  domain: "err",
  defaults: {},
  hash: (v) => v.text,
  toDoc: (v) => ({ text: v.text }),
  fromDoc: (d) => (typeof d.text === "string" ? { text: d.text } : null),
};

describe("M16 error taxonomy", () => {
  test("promote of a non-existent version throws VersionNotFoundError (a VersionedStoreError)", async () => {
    const s = createVersionedStore(cfg, createInMemoryBackend());
    await assert.rejects(
      () => s.promote("k", 99),
      (e) => e instanceof VersionNotFoundError && e instanceof VersionedStoreError && e.version === 99,
    );
  });

  test("a gate-refused promote throws GateRejectedError carrying the failures", async () => {
    const s = createVersionedStore(cfg, createInMemoryBackend());
    await s.addVersion("k", { text: "x" });
    await assert.rejects(
      () => s.promote("k", 1, { gate: () => ({ passed: false, failures: ["nope"] }) }),
      (e) => e instanceof GateRejectedError && e instanceof VersionedStoreError && e.failures.includes("nope"),
    );
  });

  test("BackendConflictError and CasExhaustedError extend the base VersionedStoreError", () => {
    assert.ok(new BackendConflictError("k", 1) instanceof VersionedStoreError);
    assert.ok(new CasExhaustedError("d", "k", 5) instanceof VersionedStoreError);
  });
});

describe("isVersionedStoreError (cross-copy brand)", () => {
  const BRAND = Symbol.for("@versioned-store/core:VersionedStoreError");

  test("recognizes the base and every subclass (brand inherited via super())", () => {
    assert.equal(isVersionedStoreError(new VersionedStoreError("x")), true);
    assert.equal(isVersionedStoreError(new VersionNotFoundError("d", "k", 1)), true);
    assert.equal(isVersionedStoreError(new GateRejectedError("d", "k", 1, ["f"])), true);
    assert.equal(isVersionedStoreError(new CasExhaustedError("d", "k", 5)), true);
    assert.equal(isVersionedStoreError(new BackendConflictError("k", 1)), true);
  });

  test("rejects non-store values", () => {
    for (const v of [new Error("plain"), null, undefined, {}, "VersionedStoreError", 42, []]) {
      assert.equal(isVersionedStoreError(v), false);
    }
  });

  // The reason isVersionedStoreError exists. A second loaded copy of this package (a transitive version split
  // or a bundler dup) throws errors that are instances of THAT copy's class, so `instanceof` against this
  // copy's class returns false. The error still carries the global-registry brand, so the guard still matches.
  // Reverting isVersionedStoreError to `err instanceof VersionedStoreError` fails this test.
  test("matches a foreign-copy error that instanceof cannot see", () => {
    const foreign = Object.assign(Object.create(Error.prototype), {
      message: "thrown by another loaded copy of the package",
      [BRAND]: true,
    });
    assert.equal(foreign instanceof VersionedStoreError, false, "instanceof cannot cross the copy boundary");
    assert.equal(isVersionedStoreError(foreign), true, "the brand can");
  });

  test("the brand is symbol-keyed, so it never leaks into Object.keys or JSON", () => {
    const e = new VersionedStoreError("x");
    assert.ok(Object.getOwnPropertySymbols(e).includes(BRAND), "brand present as a symbol-keyed own property");
    assert.ok(!Object.keys(e).some((k) => k.includes("VersionedStoreError")), "brand absent from string keys");
    assert.ok(!("Symbol(@versioned-store/core:VersionedStoreError)" in JSON.parse(JSON.stringify(e))));
  });
});

describe("M16 refs pass-through", () => {
  beforeEach(() => resetStoreEventCounts());

  test("promote threads consumer-owned refs into its emitted event", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const capturing: Logger = {
      child: () => capturing,
      debug: (o) => captured.push(o as Record<string, unknown>),
      info: (o) => captured.push(o as Record<string, unknown>),
      warn: (o) => captured.push(o as Record<string, unknown>),
    };
    setStoreLogger(capturing);
    try {
      const s = createVersionedStore(cfg, createInMemoryBackend());
      await s.addVersion("k", { text: "x" });
      await s.promote("k", 1, { refs: { prompt: { key: "k", version: 1 } } });
      const accepted = captured.find((e) => e.type === "promote-accepted");
      assert.ok(accepted, "a promote-accepted event was emitted");
      assert.deepEqual(accepted.refs, { prompt: { key: "k", version: 1 } });
    } finally {
      setStoreLogger(noopLogger);
    }
  });
});
