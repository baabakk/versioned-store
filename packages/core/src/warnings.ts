// The library's own warning channel, separate from the store's event logging on purpose.
//
// `storeLog` is silent until a host injects a logger, which is the right default for a library: a dependency
// that writes to stdout uninvited is a nuisance, and store events are the host's business. A deprecation is a
// different kind of message. It is the library telling a consumer that code the consumer wrote will stop
// working, and it must arrive whether or not that consumer ever wired logging. One live consumer injects no
// logger at all, so a deprecation routed through `storeLog` would reach it never, and it would meet the removal
// release with no notice while the record claimed it had been warned for several releases.
//
// So: use the injected logger when there is one, and otherwise fall back to `console.warn`, which is the
// convention a consumer already recognises from Node's own deprecation warnings. Every warning is deduplicated
// by an explicit key so a warning on a hot path fires once per process, and any key can be suppressed by a
// consumer that has already migrated.

import { hasInjectedLogger, storeLog } from "./logger.js";

const log = storeLog("warnings");

const _warned = new Set<string>();
const _suppressed = new Set<string>();
let _handler: ((message: string, key: string) => void) | undefined;

/**
 * Route warnings somewhere other than the console. Call once at startup, before constructing stores.
 *
 * The handler receives the fully formatted message and the deduplication key, so a host can forward it into
 * structured logging, assert on it in a test, or count it as a metric. Setting a handler replaces BOTH the
 * injected-logger path and the console fallback, so a host that sets one owns delivery entirely.
 *
 * @example
 * setWarningHandler((message, key) => metrics.increment("store.deprecation", { key }));
 */
export function setWarningHandler(handler: (message: string, key: string) => void): void {
  _handler = handler;
}

/**
 * Silence one warning key permanently, for a consumer that has already handled it.
 *
 * Prefer this over filtering log lines: it is explicit, it lives at the composition root next to the store
 * construction it relates to, and it leaves the other warnings working. Suppressing a key that never fires is
 * harmless, so a consumer can suppress ahead of an upgrade.
 *
 * @example
 * suppressWarning("encrypted-fields-without-cipher"); // we store these in plaintext deliberately
 */
export function suppressWarning(key: string): void {
  _suppressed.add(key);
}

/**
 * Emit `message` at most once per `key` per process.
 *
 * Delivery order: an explicit handler if one was set, otherwise the injected logger if the host wired one,
 * otherwise `console.warn`. Never throws: a warning that breaks a caller would be worse than the thing it warns
 * about.
 */
export function warnOnce(key: string, message: string): void {
  if (_suppressed.has(key) || _warned.has(key)) return;
  _warned.add(key);
  try {
    if (_handler) _handler(message, key);
    else if (hasInjectedLogger()) log.warn({ key }, message);
    // eslint-disable-next-line no-console
    else console.warn(`[versioned-store] ${message}`);
  } catch {
    // A failing warning sink must not disrupt the operation that triggered it.
  }
}

/** What a deprecation has to state. A deprecation that does not name a replacement is not shippable. */
export interface DeprecationDetails {
  /** What is deprecated, named as the consumer sees it: a method, an option, a behaviour. */
  what: string;
  /** What to use instead. Required, because "this is going away" without a destination is not actionable. */
  use: string;
  /** The release the removal is expected in, so a consumer can plan rather than guess. */
  removedIn: string;
}

/**
 * Warn that something a consumer calls is going to change, once per key per process.
 *
 * The window this opens is measured in consumer upgrades rather than releases: four of six known consumers pin
 * exactly and see a warning only when they choose to upgrade, so a removal waits until they have.
 *
 * @example
 * warnDeprecated("revert-pins-a-copy", {
 *   what: "revertToCodeDefault writes a copy of the shipped default as a new version",
 *   use: "revertToCodeDefault({ clearLabel: true }), which falls through to the code default",
 *   removedIn: "0.1.0-beta.12",
 * });
 */
export function warnDeprecated(key: string, details: DeprecationDetails): void {
  warnOnce(
    key,
    `DEPRECATED: ${details.what}. Use ${details.use}. Expected removal: ${details.removedIn}. ` +
      `Silence this with suppressWarning(${JSON.stringify(key)}).`,
  );
}

/** Test-only: forget every warning already emitted, and every suppression and handler. */
export function resetWarnings(): void {
  _warned.clear();
  _suppressed.clear();
  _handler = undefined;
}
