// Error taxonomy (OSS Release Playbook §4, design 08 M16). Every error the store throws extends the single
// base `VersionedStoreError`, so a consumer's blanket `catch (e instanceof VersionedStoreError)` keeps working
// across releases while a specific catcher adds one line. Subclasses give a BREAKING release a natural place to
// add specificity without changing the base contract. `BackendConflictError` lives in backend.ts (it is part
// of the backend contract) but also extends this base, so the same blanket handler catches it.

/** Base class for every error thrown by the versioned store. Catch this to handle any store failure. */
export class VersionedStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionedStoreError";
  }
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
