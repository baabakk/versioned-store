// Shadow-promote + canary with gate-driven auto-rollback (design 08 M12, moonshot two). The movable-label
// model already supports arbitrary labels, so `canary` and `shadow` are just two more labels; this module adds
// the runtime loop the config-store lineage only does post-live in hosted platforms — here embedded, over
// arbitrary T, with NO hosted service:
//   - promoteCanary / promoteShadow: point the canary/shadow label at a candidate (optionally gated).
//   - resolveWeighted: serve the canary version to a caller-controlled fraction of resolves (the `roll` is
//     injected — a request-id hash or RNG — so the split is deterministic + testable), else the active version.
//   - resolveShadow: resolve active + shadow together so the caller can compare outputs without serving shadow.
//   - evaluateCanary: run a RUNNING gate over the live canary version; on failure, auto-DEMOTE it (re-point the
//     canary label to the last-known-good = the active version) so no more traffic hits the bad version, and
//     AUDIT + ALARM the rollback (a promote-refused store event carrying the failures).

import { emitStoreEvent, STORE_EVENT_SCHEMA_VERSION } from "./events.js";
import type { Gate, Resolved, VersionedStore } from "./versionedStore.js";

export const CANARY_LABEL = "canary";
export const SHADOW_LABEL = "shadow";

/** Point the canary label at a version (optionally gated by the deterministic tier before it goes canary). */
export function promoteCanary<T>(store: VersionedStore<T>, key: string, version: number, opts: { gate?: Gate<T>; by?: string } = {}): Promise<void> {
  return store.promote(key, version, { label: CANARY_LABEL, gate: opts.gate, by: opts.by });
}

/** Point the shadow label at a version (resolved for comparison, never served to users). */
export function promoteShadow<T>(store: VersionedStore<T>, key: string, version: number, opts: { gate?: Gate<T>; by?: string } = {}): Promise<void> {
  return store.promote(key, version, { label: SHADOW_LABEL, gate: opts.gate, by: opts.by });
}

/**
 * Serve the canary version to `roll < canaryFraction`, else the active version. `roll` in [0,1) is injected by
 * the caller (a stable hash of the request/user id for sticky canary, or a RNG for uniform) so the split is
 * the caller's policy and stays deterministic under test. Falls back to active when no canary is set.
 */
export async function resolveWeighted<T>(
  store: VersionedStore<T>,
  key: string,
  opts: { canaryFraction: number; roll: number; activeLabel?: string },
): Promise<Resolved<T> | null> {
  if (opts.roll < opts.canaryFraction) {
    const canary = await store.getActiveVersion(key, CANARY_LABEL);
    if (canary) return canary;
  }
  return store.resolve(key, opts.activeLabel ?? "active");
}

/** Resolve the active + shadow versions together for offline comparison (shadow is never served to users). */
export async function resolveShadow<T>(store: VersionedStore<T>, key: string, opts: { activeLabel?: string } = {}): Promise<{ active: Resolved<T> | null; shadow: Resolved<T> | null }> {
  return {
    active: await store.resolve(key, opts.activeLabel ?? "active"),
    shadow: await store.getActiveVersion(key, SHADOW_LABEL),
  };
}

export interface CanaryEvaluation {
  key: string;
  canaryVersion: number | null;
  gatePassed: boolean | null; // null => no canary set (nothing evaluated)
  rolledBack: boolean;
  rolledBackTo: number | null; // the last-known-good (active) version the canary was demoted to
  failures: string[];
}

/**
 * Evaluate the live canary version against a RUNNING gate and auto-rollback on failure. On a failing gate the
 * canary label is re-pointed to the last-known-good (the active version) so it stops serving the bad version,
 * and the demotion is audited (the label move emits a promote event) + alarmed (a promote-refused event with
 * the failures). A passing gate leaves the canary in place. Idempotent when there is no canary or the gate passes.
 */
export async function evaluateCanary<T>(
  store: VersionedStore<T>,
  key: string,
  gate: Gate<T>,
  opts: { activeLabel?: string; by?: string; domain?: string } = {},
): Promise<CanaryEvaluation> {
  const canary = await store.getActiveVersion(key, CANARY_LABEL);
  if (!canary) return { key, canaryVersion: null, gatePassed: null, rolledBack: false, rolledBackTo: null, failures: [] };

  const result = await gate(canary.value);
  if (result.passed) {
    return { key, canaryVersion: canary.version, gatePassed: true, rolledBack: false, rolledBackTo: null, failures: [] };
  }

  const active = await store.getActiveVersion(key, opts.activeLabel ?? "active");
  const lkg = active?.version ?? null;
  if (lkg !== null) {
    // Re-point canary -> last-known-good, unconditionally (lkg is already the live active version).
    await store.promote(key, lkg, { label: CANARY_LABEL, by: opts.by ?? "canary-controller" });
  }
  // Alarm: a distinct promote-refused event on the FAILED canary version (carries the gate failures).
  emitStoreEvent({
    schemaVersion: STORE_EVENT_SCHEMA_VERSION,
    type: "promote-refused",
    domain: opts.domain ?? "canary",
    key,
    version: canary.version,
    label: CANARY_LABEL,
    failures: [`canary auto-rollback: ${result.failures.join("; ")}`],
  });
  return { key, canaryVersion: canary.version, gatePassed: false, rolledBack: lkg !== null, rolledBackTo: lkg, failures: result.failures };
}
