// Content-addressed portable version bundles (design 08 M11). Extends the M7 export/import into a SEALED,
// tamper-evident, optionally-signed single-object format: a whole store (every immutable version + its
// labels — i.e. the full version history, which IS the store's audit trail) sealed under one content hash, so
// any change to any version or label after sealing is detected on import. With a secret, an HMAC signature
// also proves provenance. This makes a store trivially forkable, diffable, and immune to vendor sunset: an
// exported bundle imports into ANY backend and self-verifies. Uses node:crypto (a service/lib module, not the
// Temporal workflow sandbox), so createHash / createHmac are fine here.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { VersionedStoreBackend } from "./backend.js";
import { exportBackend, importBundle, type StoreBundle } from "./migrate.js";

/**
 * A {@link StoreBundle} sealed under a content hash, and optionally signed. Sealing turns a portable export
 * into a tamper-evident one: any edit to any version or label after sealing changes the recomputed hash, so
 * `verifyBundle` catches it and `importSealedBundle` refuses the import. With a shared secret, the HMAC adds
 * provenance on top of integrity (this bundle came from someone holding the secret, not merely from a file
 * nobody happened to modify).
 *
 * The seal covers the FULL version history, not just the current state, which is what makes an exported store
 * checkable long after it left the machine that produced it.
 */
export interface SealedBundle extends StoreBundle {
  /** Seal format discriminator, independent of the bundle's own `bundleVersion`. Verification refuses any other value. */
  sealedFormat: 1;
  /** sha256 over the canonical (sorted) versions + labels — the tamper-evident seal over the full history. */
  contentHash: string;
  /** Optional HMAC-sha256(contentHash, secret): provenance + integrity when a shared secret is used. */
  signature?: string;
}

// Deterministic serialization: recursively sort object keys so the hash is stable across backends (which may
// reorder fields on a JSON round-trip) and across runs. Two byte-identical histories always seal to the same hash.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function contentHashOf(bundle: StoreBundle): string {
  const versions = [...bundle.versions].sort((a, b) => (a.key === b.key ? a.version - b.version : a.key < b.key ? -1 : 1));
  const labels = [...bundle.labels].sort((a, b) => (a.key === b.key ? (a.label < b.label ? -1 : 1) : a.key < b.key ? -1 : 1));
  return createHash("sha256").update(canonical({ versions, labels })).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Seal a bundle: stamp the content hash (tamper-evident) and, with a secret, an HMAC signature (provenance). */
export function sealBundle(bundle: StoreBundle, opts: { secret?: string } = {}): SealedBundle {
  const contentHash = contentHashOf(bundle);
  const sealed: SealedBundle = { ...bundle, sealedFormat: 1, contentHash };
  if (opts.secret) sealed.signature = createHmac("sha256", opts.secret).update(contentHash).digest("hex");
  return sealed;
}

/**
 * The outcome of `verifyBundle`. It is a returned result rather than a thrown error because verification is
 * usually a decision point (quarantine the file, alert an operator, keep serving the previous bundle) rather
 * than a crash; `importSealedBundle` is the variant that throws on your behalf.
 *
 * `reason` is present only when `valid` is false, and it names which check failed (unknown seal format,
 * content-hash mismatch, a secret supplied for an unsigned bundle, or a signature mismatch) so the failure is
 * actionable instead of merely negative.
 */
export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/** Verify a sealed bundle: recompute the content hash (detects any tampering) and, with a secret, the HMAC. */
export function verifyBundle(sealed: SealedBundle, opts: { secret?: string } = {}): VerifyResult {
  if (sealed.sealedFormat !== 1) return { valid: false, reason: `unknown sealed bundle format ${sealed.sealedFormat}` };
  if (contentHashOf(sealed) !== sealed.contentHash) {
    return { valid: false, reason: "content hash mismatch — the bundle was modified after sealing" };
  }
  if (opts.secret) {
    if (!sealed.signature) return { valid: false, reason: "a secret was provided but the bundle is unsigned" };
    const expected = createHmac("sha256", opts.secret).update(sealed.contentHash).digest("hex");
    if (!safeEqualHex(expected, sealed.signature)) return { valid: false, reason: "signature mismatch — wrong secret or forged bundle" };
  }
  return { valid: true };
}

/** Export a backend and seal the result in one step. */
export async function exportSealed(backend: VersionedStoreBackend, opts: { labels?: string[]; secret?: string } = {}): Promise<SealedBundle> {
  return sealBundle(await exportBackend(backend, { labels: opts.labels }), { secret: opts.secret });
}

/** Verify a sealed bundle, then import it. Refuses (throws) a tampered or unverifiable bundle. */
export async function importSealedBundle(backend: VersionedStoreBackend, sealed: SealedBundle, opts: { secret?: string } = {}): Promise<void> {
  const v = verifyBundle(sealed, opts);
  if (!v.valid) throw new Error(`refusing to import an unverified bundle: ${v.reason}`);
  await importBundle(backend, sealed);
}
