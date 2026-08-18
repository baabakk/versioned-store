// createDrainableSink (TD-VS-15): make an async onEvent sink flushable, so a short-lived host (a CLI) can
// await its writes before closing the backend. The load-bearing test is the race itself: a deferred write that
// a bare fire-and-forget sink loses at close, and that the drain saves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDrainableSink, STORE_EVENT_SCHEMA_VERSION, type StoreEvent } from "./events.js";

function promoteEvent(key: string): StoreEvent {
  return { schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "promote-accepted", domain: "test", key, version: 1, label: "active", by: "op" };
}

describe("createDrainableSink", () => {
  it("drain() awaits a deferred write that a bare fire-and-forget sink would lose at close", async () => {
    // Model the TD-VS-15 race: the write needs a live session and runs one microtask AFTER onEvent returns,
    // exactly like a networked insert scheduled inside a detached promise.
    let sessionOpen = true;
    const landed: string[] = [];
    const inner = async (e: StoreEvent) => {
      await Promise.resolve(); // defer past the synchronous emit
      if (!sessionOpen) throw new Error("Cannot use a session that has ended");
      landed.push(e.key);
    };
    const sink = createDrainableSink(inner);

    sink.onEvent(promoteEvent("a")); // the store calls this synchronously inside promote()
    await sink.drain(); // the CLI awaits the drain...
    sessionOpen = false; // ...THEN closes the connection

    assert.deepEqual(landed, ["a"]);
  });

  it("proves the drain is load-bearing: without it, the same write is lost and routed to onError", async () => {
    let sessionOpen = true;
    const landed: string[] = [];
    const failures: string[] = [];
    const inner = async (e: StoreEvent) => {
      await Promise.resolve();
      if (!sessionOpen) throw new Error("session ended");
      landed.push(e.key);
    };
    const sink = createDrainableSink(inner, { onError: (_e, err) => failures.push(err instanceof Error ? err.message : String(err)) });

    sink.onEvent(promoteEvent("a"));
    sessionOpen = false; // close immediately, no drain — the deferred write will find it closed
    await new Promise((r) => setTimeout(r, 0)); // let the deferred write run

    assert.deepEqual(landed, []);
    assert.deepEqual(failures, ["session ended"]);
  });

  it("onEvent never throws when inner throws synchronously; the error is routed to onError", async () => {
    const failures: unknown[] = [];
    const sink = createDrainableSink(
      () => {
        throw new Error("sync boom");
      },
      { onError: (_e, err) => failures.push(err) },
    );
    assert.doesNotThrow(() => sink.onEvent(promoteEvent("a")));
    await sink.drain();
    assert.equal(failures.length, 1);
  });

  it("drain() resolves even when writes reject (Promise.all cannot reject out of it)", async () => {
    const sink = createDrainableSink(async () => {
      throw new Error("reject");
    });
    sink.onEvent(promoteEvent("a"));
    await assert.doesNotReject(() => sink.drain());
  });

  it("drain() with nothing in flight resolves immediately", async () => {
    const sink = createDrainableSink(async () => {});
    await assert.doesNotReject(() => sink.drain());
  });

  it("tracks and awaits multiple concurrent writes", async () => {
    const landed: string[] = [];
    const sink = createDrainableSink(async (e) => {
      await Promise.resolve();
      landed.push(e.key);
    });
    sink.onEvent(promoteEvent("a"));
    sink.onEvent(promoteEvent("b"));
    sink.onEvent(promoteEvent("c"));
    await sink.drain();
    assert.deepEqual(landed.sort(), ["a", "b", "c"]);
  });
});
