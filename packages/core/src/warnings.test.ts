// The warning channel. The load-bearing property is the one the store's event logging deliberately does NOT
// have: a warning must reach a consumer that never injected a logger, because one live consumer never does and
// would otherwise receive no deprecation notice at all before a removal.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWarnings,
  setWarningHandler,
  suppressWarning,
  warnDeprecated,
  warnOnce,
} from "./warnings.js";
import { noopLogger, setStoreLogger, type Logger } from "./logger.js";

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  return { lines, restore: () => void (console.warn = original) };
}

function recordingLogger(sink: string[]): Logger {
  const rec: Logger = {
    child: () => rec,
    debug: () => {},
    info: () => {},
    warn: (_obj, msg) => void sink.push(String(msg)),
  };
  return rec;
}

describe("warnings: reaching a consumer that wired no logging", () => {
  beforeEach(() => {
    resetWarnings();
    setStoreLogger(noopLogger);
  });
  afterEach(() => setStoreLogger(noopLogger));

  it("falls back to the console when no logger was injected", () => {
    const c = captureConsole();
    try {
      warnOnce("k", "something is inert");
    } finally {
      c.restore();
    }
    assert.equal(c.lines.length, 1);
    assert.match(c.lines[0], /\[versioned-store\] something is inert/);
  });

  it("uses the injected logger instead of the console when the host wired one", () => {
    const logged: string[] = [];
    setStoreLogger(recordingLogger(logged));
    const c = captureConsole();
    try {
      warnOnce("k", "something is inert");
    } finally {
      c.restore();
    }
    assert.deepEqual(logged, ["something is inert"]);
    assert.equal(c.lines.length, 0, "must not double-report on the console");
  });

  it("fires once per key per process, however many times it is called", () => {
    const c = captureConsole();
    try {
      for (let i = 0; i < 50; i++) warnOnce("hot-path", "on a hot path");
      warnOnce("other", "a different one");
    } finally {
      c.restore();
    }
    assert.equal(c.lines.length, 2);
  });

  it("stays silent for a key the consumer suppressed, and suppressing ahead of time is allowed", () => {
    const c = captureConsole();
    try {
      suppressWarning("handled");
      warnOnce("handled", "already migrated");
      warnOnce("not-handled", "still relevant");
    } finally {
      c.restore();
    }
    assert.equal(c.lines.length, 1);
    assert.match(c.lines[0], /still relevant/);
  });

  it("routes through an explicit handler, bypassing both the logger and the console", () => {
    const logged: string[] = [];
    setStoreLogger(recordingLogger(logged));
    const seen: Array<[string, string]> = [];
    setWarningHandler((message, key) => void seen.push([key, message]));
    const c = captureConsole();
    try {
      warnOnce("k", "routed");
    } finally {
      c.restore();
    }
    assert.deepEqual(seen, [["k", "routed"]]);
    assert.equal(c.lines.length, 0);
    assert.equal(logged.length, 0);
  });

  it("never throws when the handler throws, because a warning must not break its caller", () => {
    setWarningHandler(() => {
      throw new Error("sink is broken");
    });
    assert.doesNotThrow(() => warnOnce("k", "still fine"));
  });
});

describe("warnings: a deprecation states what to do instead", () => {
  beforeEach(() => {
    resetWarnings();
    setStoreLogger(noopLogger);
  });

  it("names the replacement and the expected removal, and how to silence it", () => {
    const seen: string[] = [];
    setWarningHandler((m) => void seen.push(m));
    warnDeprecated("revert-pins-a-copy", {
      what: "revertToCodeDefault writes a copy of the shipped default",
      use: "revertToCodeDefault({ clearLabel: true })",
      removedIn: "0.1.0-beta.12",
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^DEPRECATED: revertToCodeDefault writes a copy/);
    assert.match(seen[0], /Use revertToCodeDefault\(\{ clearLabel: true \}\)/);
    assert.match(seen[0], /Expected removal: 0\.1\.0-beta\.12/);
    assert.match(seen[0], /suppressWarning\("revert-pins-a-copy"\)/);
  });

  it("deduplicates like any other warning", () => {
    const seen: string[] = [];
    setWarningHandler((m) => void seen.push(m));
    const details = { what: "a", use: "b", removedIn: "c" };
    warnDeprecated("dup", details);
    warnDeprecated("dup", details);
    assert.equal(seen.length, 1);
  });
});
