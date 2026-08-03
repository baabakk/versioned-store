// Error taxonomy (OSS Release Playbook §4, design 08 M16). Every error the store throws extends the single
// base `VersionedStoreError`, so a consumer's blanket `catch (e instanceof VersionedStoreError)` keeps working
// across releases while a specific catcher adds one line. Subclasses give a BREAKING release a natural place to
// add specificity without changing the base contract. `BackendConflictError` lives in backend.ts (it is part
// of the backend contract) but also extends this base, so the same blanket handler catches it.

// Cross-copy brand. `Symbol.for` resolves through the GLOBAL symbol registry, so the same symbol is returned
// even when two copies of this package are loaded (a transitive version split, or a bundler that duplicates
// it). `instanceof` compares against one copy's class object and returns false across that boundary; a brand
// keyed on a global symbol does not. This is the same hazard/remedy as the zod `instanceof`-across-copies fix
// in prompt-store (TD-VS-06): prefer the structural check over identity when the check crosses a package edge.
const BRAND = Symbol.for("@versioned-store/core:VersionedStoreError");

/** Base class for every error thrown by the versioned store. Catch this to handle any store failure. */
export class VersionedStoreError extends Error {
  // Set on every instance (subclasses inherit it: base field initializers run during `super()`). Symbol-keyed,
  // so it never appears in `Object.keys`/`JSON.stringify`. Read it via `isVersionedStoreError`, not directly.
  readonly [BRAND] = true;
  constructor(message: string) {
    super(message);
    this.name = "VersionedStoreError";
  }
}

/**
 * Robust alternative to `err instanceof VersionedStoreError`. Returns true for any error thrown by this
 * library, INCLUDING one thrown by a different loaded copy of the package (version split or bundler dup),
 * where `instanceof` would return false. Prefer this for a blanket catch that must cover the whole library:
 * `try { ... } catch (e) { if (isVersionedStoreError(e)) { ... } }`.
 */
export function isVersionedStoreError(err: unknown): err is VersionedStoreError {
  return typeof err === "object" && err !== null && (err as Record<PropertyKey, unknown>)[BRAND] === true;
}

/** `promote` referenced a (key, version) that does not exist. */
export class VersionNotFoundError extends VersionedStoreError {
  constructor(
    public readonly domain: string,
    public readonly key: string,
    public readonly version: number,
  ) {
    super(`[store:${domain}] cannot promote ${key} v${version}: version does not exist`);
    this.name = "VersionNotFoundError";
  }
}

/** An eval-gate refused a `promote`. `failures` carries the gate's reasons (same list on the promote-refused event). */
export class GateRejectedError extends VersionedStoreError {
  constructor(
    public readonly domain: string,
    public readonly key: string,
    public readonly version: number,
    public readonly failures: string[],
  ) {
    super(`[store:${domain}] cannot promote ${key} v${version}: gate failed:\n${failures.join("\n")}`);
    this.name = "GateRejectedError";
  }
}

/** `addVersion` exhausted its optimistic-CAS retry budget under persistent version-bump contention. */
export class CasExhaustedError extends VersionedStoreError {
  constructor(
    public readonly domain: string,
    public readonly key: string,
    public readonly attempts: number,
  ) {
    super(`[store:${domain}] addVersion(${key}) failed after ${attempts} CAS attempts (persistent version-bump contention)`);
    this.name = "CasExhaustedError";
  }
}
