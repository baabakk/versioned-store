import { storeLog } from "./logger.js";

const log = storeLog("store-events");

/**
 * Stable, versioned schema for structured store observability events (design 08 M3). Bump when the shape of
 * any StoreEvent variant changes, so a consumer wiring alerts can gate on `schemaVersion`.
 */
export const STORE_EVENT_SCHEMA_VERSION = 1;

/** Why the store served the code default instead of the intended DB version, or why a render failed. */
export type FallbackReason =
  | "backend-unavailable"  // backendAvailable() returned false -> code default is expected (debug, not an alarm)
  | "label-missing"        // DB up, but no active label for the key
  | "doc-missing"          // the label points to a version that is not in the collection
  | "resolve-error"        // a DB error after the store was configured
  | "schema-invalid"       // the stored value failed validation on read
  | "unbound-placeholder"; // a render left a {{placeholder}} unbound (prompt domain)

/**
 * A structured store event. This discriminated union IS the documented, versioned schema (design 08 M3/M16):
 * every event carries `schemaVersion` + `type` + `domain` + `key`, then per-type fields. Consumers wire alerts
 * off `type` (e.g. any `promote-refused`, or a rising `fallback` count).
 *
 * `refs` is CONSUMER-owned trace metadata (OSS Release Playbook §7.3): the store never reads, validates, or
 * sends it — it only passes it through — so a consumer can stamp `{ prompt: { key, version, hash } }` or
 * `{ tenant, experiment }` at a promote for its own tracing.
 *
 * OTel mapping (§7.2): a consumer maps `type` to a `versioned_store.<type>` span/metric name and the fields to
 * attributes; the schema is versioned via `schemaVersion` so new fields can be added without a BREAKING release.
 */
export type StoreEvent =
  | { schemaVersion: typeof STORE_EVENT_SCHEMA_VERSION; type: "fallback"; domain: string; key: string; reason: FallbackReason; extra?: Record<string, unknown>; refs?: Record<string, unknown> }
  | { schemaVersion: typeof STORE_EVENT_SCHEMA_VERSION; type: "gate-outcome"; domain: string; key: string; version: number; passed: boolean; failures: string[]; refs?: Record<string, unknown> }
  | { schemaVersion: typeof STORE_EVENT_SCHEMA_VERSION; type: "promote-accepted"; domain: string; key: string; version: number; label: string; by: string; refs?: Record<string, unknown> }
  | { schemaVersion: typeof STORE_EVENT_SCHEMA_VERSION; type: "promote-refused"; domain: string; key: string; version: number; label: string; failures: string[]; refs?: Record<string, unknown> };

const _counts = new Map<string, number>();

/**
 * Emit a structured store event (design 08 M3). Increments a per-`${type}:${domain}` counter and logs at a
 * level matched to severity: promote-refused + a failed gate + a genuine wrong-version fallback WARN;
 * accepted promotes, passing gates, and benign fallbacks (mongo-unconfigured / first-class code default)
 * are info/debug. Side effects only (structured log + counter); never throws.
 */
export function emitStoreEvent(event: StoreEvent, opts: { alarm?: boolean } = {}): void {
  const counterKey = `${event.type}:${event.domain}`;
  const count = (_counts.get(counterKey) ?? 0) + 1;
  _counts.set(counterKey, count);
  const payload = { ...event, count };
  switch (event.type) {
    case "promote-refused":
      log.warn(payload, "store promote REFUSED by the eval-gate");
      break;
    case "promote-accepted":
      log.info(payload, "store promote accepted");
      break;
    case "gate-outcome":
      if (event.passed) log.debug(payload, "store eval-gate passed");
      else log.warn(payload, "store eval-gate failed");
      break;
    case "fallback":
      if (event.reason === "backend-unavailable" || opts.alarm === false) log.debug(payload, "store served code default");
      else log.warn(payload, "store fell back to code default / render failed — served the WRONG or default version");
      break;
  }
}

/**
 * Record a fallback-to-default (or a render failure). A thin convenience wrapper over emitStoreEvent for the
 * `fallback` event, keeping the prior signature so existing call sites (core resolve, prompt render) are
 * unchanged. `mongo-unconfigured` and `alarm:false` log at debug; otherwise WARN. Never throws.
 */
export function recordFallback(
  domain: string,
  key: string,
  reason: FallbackReason,
  opts: { alarm?: boolean; extra?: Record<string, unknown> } = {},
): void {
  emitStoreEvent(
    { schemaVersion: STORE_EVENT_SCHEMA_VERSION, type: "fallback", domain, key, reason, extra: opts.extra },
    { alarm: opts.alarm },
  );
}

/** Snapshot of ALL store-event counts keyed by `${type}:${domain}` (the ops metrics surface). Per-process. */
export function getStoreEventCounts(): Record<string, number> {
  return Object.fromEntries([..._counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Fallback-only counts (`fallback:${domain}` keys). Back-compat with the prior metrics surface. */
export function getFallbackCounts(): Record<string, number> {
  return Object.fromEntries([..._counts.entries()].filter(([k]) => k.startsWith("fallback:")).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Reset all counters. Test-only (isolates per-test assertions on the module-global counter). */
export function resetStoreEventCounts(): void {
  _counts.clear();
}
