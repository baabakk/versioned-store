// Redis VersionedStoreBackend (design 08 M5). A pure-KV adapter: Redis has no schema, so this hand-maintains
// the three auxiliary structures the contract needs, all namespaced by an injected `prefix`:
//   {prefix}:v:{key}:{version}  -> the immutable StoredDoc (a plain string value)
//   {prefix}:zv:{key}           -> a sorted set of a key's versions (score = member = version) for MAX / order
//   {prefix}:keys               -> a set of every key that has >=1 version (for distinctKeys)
//   {prefix}:l:{key}:{label}    -> the movable LabelDoc (a plain string value)
//
// KV HONESTY (design 08 §2.6, M5): a server DB gets immutability + secondary indexes for free; a KV store
// must synthesize them, and a naive multi-command insert can leave the version doc written but absent from
// the sorted set if the client dies mid-write. So insertVersion runs a single Lua script (atomic in Redis):
// it guards on EXISTS (immutability -> BackendConflictError on a re-insert, the CAS signal) and writes the
// doc + both indexes together, so the three structures never diverge under concurrency or an interrupted
// client. The client is INJECTED (a minimal RedisLike), so there is no runtime `ioredis` dependency and any
// compatible client (ioredis, node-redis wrapper, or the ioredis-mock used in the conformance suite) works.

import { BackendConflictError, type LabelDoc, type StoredDoc, type VersionedStoreBackend } from "../backend.js";

/** The minimal Redis surface this backend uses. Both `ioredis` and `ioredis-mock` satisfy it structurally. */
export interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic insert: EXISTS guard on the version doc, then write doc + version-sorted-set + keys-set together.
// Returns 1 if inserted, 0 if (key,version) already existed. KEYS: 1=doc 2=zv 3=keys. ARGV: 1=json 2=version 3=key.
const INSERT_LUA =
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end " +
  "redis.call('SET', KEYS[1], ARGV[1]) " +
  "redis.call('ZADD', KEYS[2], ARGV[2], ARGV[2]) " +
  "redis.call('SADD', KEYS[3], ARGV[3]) " +
  "return 1";

/**
 * Create the Redis backend over an injected client. Redis has no schema, so the adapter hand-maintains the
 * three structures the contract needs, all namespaced under `prefix`: the version doc itself, a sorted set of
 * a key's versions (giving `maxVersion` and descending order), and a set of every key holding at least one
 * version (giving `distinctKeys`).
 *
 * Hand-maintained indexes are exactly where a pure-KV adapter goes wrong, so `insertVersion` runs one Lua
 * script instead of a sequence of commands: it guards on `EXISTS` (a re-insert raises
 * {@link BackendConflictError}, the core's compare-and-swap signal) and writes the doc plus both indexes
 * together. A client that dies mid-write therefore cannot leave a version doc that no index knows about.
 *
 * @param redis Any client satisfying {@link RedisLike}. It is injected, so the package takes no runtime
 * dependency on `ioredis` and a node-redis wrapper or an in-process mock works just as well.
 * @param prefix Namespace for every key this store writes. Give each store its own: two stores sharing a
 * prefix would share their key set and collide on version docs.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * import { createVersionedStore, createRedisBackend } from "@versioned-store/core";
 *
 * const store = createVersionedStore<FeatureFlagSet>(
 *   flagCfg,
 *   createRedisBackend(new Redis(process.env.REDIS_URL!), "flags"),
 * );
 *
 * const v = await store.addVersion("checkout", nextFlags);
 * await store.promote("checkout", v, { by: "release-bot" });
 * ```
 */
export function createRedisBackend(redis: RedisLike, prefix: string): VersionedStoreBackend {
  const vKey = (key: string, version: number) => `${prefix}:v:${key}:${version}`;
  const zKey = (key: string) => `${prefix}:zv:${key}`;
  const keysKey = `${prefix}:keys`;
  const lKey = (key: string, label: string) => `${prefix}:l:${key}:${label}`;

  return {
    async init(): Promise<void> {
      // No schema to create — the keyspace is the store.
    },

    async getVersion(key: string, version: number): Promise<StoredDoc | null> {
      const raw = await redis.get(vKey(key, version));
      return raw === null ? null : (JSON.parse(raw) as StoredDoc);
    },

    async maxVersion(key: string): Promise<number | null> {
      const top = await redis.zrevrange(zKey(key), 0, 0);
      return top.length ? Number(top[0]) : null;
    },

    async insertVersion(doc: StoredDoc): Promise<void> {
      const res = await redis.eval(INSERT_LUA, 3, vKey(doc.key, doc.version), zKey(doc.key), keysKey, JSON.stringify(doc), String(doc.version), doc.key);
      if (Number(res) === 0) throw new BackendConflictError(doc.key, doc.version);
    },

    async listVersionsDesc(key: string): Promise<StoredDoc[]> {
      const versions = await redis.zrevrange(zKey(key), 0, -1);
      if (!versions.length) return [];
      const raws = await redis.mget(...versions.map((v) => vKey(key, Number(v))));
      return raws.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as StoredDoc);
    },

    async distinctKeys(): Promise<string[]> {
      return (await redis.smembers(keysKey)).sort();
    },

    async getLabel(key: string, label: string): Promise<LabelDoc | null> {
      const raw = await redis.get(lKey(key, label));
      return raw === null ? null : (JSON.parse(raw) as LabelDoc);
    },

    async upsertLabel(doc: LabelDoc): Promise<void> {
      await redis.set(lKey(doc.key, doc.label), JSON.stringify(doc)); // overwrite: labels are movable
    },
  };
}
