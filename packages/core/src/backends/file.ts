// File VersionedStoreBackend (design 08 M5). A zero-dependency, durable backend over the filesystem — the
// same shape the ADW truth store uses for immutability. Layout under an injected root dir:
//   {root}/versions/{enc(key)}/{version}.json   -- one immutable StoredDoc per file
//   {root}/labels/{enc(key)}/{enc(label)}.json  -- one movable LabelDoc per file
// Immutability is the OS: a version file is written with the `wx` flag (O_CREAT | O_EXCL), so a re-write of
// an existing (key, version) fails EEXIST atomically -> BackendConflictError (the core's CAS signal; also
// safe under concurrent writers, since O_EXCL is atomic at the kernel). Keys/labels are base64url-encoded
// for the path segment so arbitrary keys are filename-safe and cannot escape the root (no ".."/"/" hazard).

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

const enc = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const dec = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "EEXIST";
}
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Create the filesystem backend: one JSON file per immutable version, one per movable label, all under
 * `rootDir`. Zero dependencies and durable, which is what makes it the right choice when a database would be
 * overkill (a CLI tool, a single-node service, a checked-in fixture directory) but process-local memory is not
 * enough.
 *
 * Immutability is delegated to the kernel rather than re-implemented: version files are written with the `wx`
 * flag (`O_CREAT | O_EXCL`), so a second write to an existing `(key, version)` fails `EEXIST` atomically and is
 * re-thrown as {@link BackendConflictError}, the compare-and-swap signal the core retries on. Because `O_EXCL`
 * is atomic at the kernel, concurrent writers are safe with no lock file. Keys and labels are base64url-encoded
 * into their path segment, so any key is filename-safe and no key can escape `rootDir`.
 *
 * @param rootDir The directory this backend owns. `init()` creates `versions/` and `labels/` beneath it. Give
 * it a dedicated path: everything under it is treated as store data.
 * @returns A backend over that directory. The data outlives the process, so constructing again over the same
 * `rootDir` re-opens the same store.
 *
 * @example
 * ```ts
 * import { createVersionedStore, createFileBackend } from "@versioned-store/core";
 *
 * const store = createVersionedStore<Prompt>(promptCfg, createFileBackend("./.data/prompts"));
 * await store.ensureIndexes();                       // creates versions/ and labels/
 *
 * const v = await store.addVersion("welcome", draft, { by: "alice" });
 * await store.promote("welcome", v, { gate, note: "copy review passed" });
 * ```
 */
export function createFileBackend(rootDir: string): VersionedStoreBackend {
  const versionsRoot = join(rootDir, "versions");
  const labelsRoot = join(rootDir, "labels");
  const versionsDir = (key: string) => join(versionsRoot, enc(key));
  const versionFile = (key: string, version: number) => join(versionsDir(key), `${version}.json`);
  const labelFile = (key: string, label: string) => join(labelsRoot, enc(key), `${enc(label)}.json`);

  async function readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async function versionNumbers(key: string): Promise<number[]> {
    try {
      return (await readdir(versionsDir(key)))
        .filter((f) => f.endsWith(".json"))
        .map((f) => Number(f.slice(0, -5)))
        .filter((n) => Number.isInteger(n));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  return {
    async init(): Promise<void> {
      await mkdir(versionsRoot, { recursive: true });
      await mkdir(labelsRoot, { recursive: true });
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      return readJson<StoredDoc>(versionFile(key, version));
    },

    async maxVersion(key: string): Promise<number | null> {
      const ns = await versionNumbers(key);
      return ns.length ? Math.max(...ns) : null;
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      await mkdir(versionsDir(doc.key), { recursive: true });
      try {
        await writeFile(versionFile(doc.key, doc.version), JSON.stringify(doc), { flag: "wx" });
      } catch (err) {
        if (isEexist(err)) throw new BackendConflictError(doc.key, doc.version);
        throw err;
      }
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      const ns = (await versionNumbers(key)).sort((a, b) => b - a);
      const docs = await Promise.all(ns.map((n) => readJson<StoredDoc>(versionFile(key, n))));
      return docs.filter((d): d is StoredDoc => d !== null);
    },

    async distinctKeys(): Promise<string[]> {
      try {
        return (await readdir(versionsRoot)).map(dec).sort();
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      return readJson<LabelDoc>(labelFile(key, label));
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      await mkdir(join(labelsRoot, enc(doc.key)), { recursive: true });
      await writeFile(labelFile(doc.key, doc.label), JSON.stringify(doc)); // overwrite: labels are movable
    },
  };
}
