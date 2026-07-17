// versioned-store CLI (design 08 M7). Backend-level verbs over a selectable backend, plus the cross-backend
// migrate/export/import tooling. A backend is named by a spec: `sqlite:<path>` (":memory:" if omitted) or
// `file:<dir>`. pg / mongo / redis need a live client, so they are driven via the library API, not this CLI.
//
// Verbs: keys | versions <key> | get <key> <ver> | label <key> <lbl> | promote <key> <ver> [lbl] |
//        rollback <key> <ver> [lbl] | export [--out f] | import <bundle.json> | migrate <src> <dst>
// The domain verbs add / seed / sync need the domain's hash + defaults (not available generically) and are
// covered by the ADW seed-prompts / seed-scaffolds scripts — see TD-VS-02.

import { readFile, writeFile } from "node:fs/promises";
import type { VersionedStoreBackend } from "./backend.js";
import { createSqliteBackend } from "./backends/sqlite.js";
import { createFileBackend } from "./backends/file.js";
import { exportBackend, importBundle, migrate, type StoreBundle } from "./migrate.js";

const USAGE = `versioned-store <verb> [args]
  keys <backend>
  versions <backend> <key>
  get <backend> <key> <version>
  label <backend> <key> <label>
  promote <backend> <key> <version> [label=active]
  rollback <backend> <key> <version> [label=active]   (= promote to an earlier version)
  export <backend> [--out <file>]
  import <backend> <bundle.json>
  migrate <source-backend> <target-backend>
backend spec: sqlite:<path>  |  file:<dir>   (pg/mongo/redis: use the library API)`;

export function backendFromSpec(spec: string): VersionedStoreBackend {
  const idx = spec.indexOf(":");
  const kind = idx === -1 ? spec : spec.slice(0, idx);
  const arg = idx === -1 ? "" : spec.slice(idx + 1);
  switch (kind) {
    case "sqlite":
      return createSqliteBackend(arg || ":memory:");
    case "file":
      if (!arg) throw new Error("file backend needs a directory: file:<dir>");
      return createFileBackend(arg);
    default:
      throw new Error(`backend "${kind}" needs a live client (pg/mongo/redis) — construct it via the library API and call migrate()/exportBackend() directly. CLI supports: sqlite:<path>, file:<dir>.`);
  }
}

async function setLabel(backend: VersionedStoreBackend, key: string, version: number, label: string, nowIso: string): Promise<void> {
  const existing = await backend.getVersion(key, version);
  if (!existing) throw new Error(`cannot point ${label} at ${key} v${version}: that version does not exist`);
  await backend.upsertLabel({ key, label, version, promotedAtIso: nowIso, promotedBy: "cli" });
}

/** `nowIso` is injected so the CLI stays deterministic under test; the bin wrapper passes the real clock. */
export async function run(argv: string[], nowIso: string): Promise<number> {
  const [verb, ...a] = argv;
  switch (verb) {
    case "keys": {
      const b = backendFromSpec(a[0]);
      await b.init();
      for (const k of await b.distinctKeys()) console.log(k);
      return 0;
    }
    case "versions": {
      const b = backendFromSpec(a[0]);
      await b.init();
      const active = (await b.getLabel(a[1], "active"))?.version;
      for (const v of await b.listVersionsDesc(a[1])) {
        console.log(`v${v.version}${v.version === active ? " *active" : ""}  ${v.sha256}  ${v.createdAtIso}  by ${v.createdBy}`);
      }
      return 0;
    }
    case "get": {
      const b = backendFromSpec(a[0]);
      const doc = await b.getVersion(a[1], Number(a[2]));
      if (!doc) return console.error("not found"), 1;
      console.log(JSON.stringify(doc, null, 2));
      return 0;
    }
    case "label": {
      const b = backendFromSpec(a[0]);
      const l = await b.getLabel(a[1], a[2]);
      console.log(l ? JSON.stringify(l, null, 2) : "(unset)");
      return 0;
    }
    case "promote":
    case "rollback": {
      const b = backendFromSpec(a[0]);
      await b.init();
      await setLabel(b, a[1], Number(a[2]), a[3] ?? "active", nowIso);
      console.log(`${a[3] ?? "active"} -> ${a[1]} v${a[2]}`);
      return 0;
    }
    case "export": {
      const b = backendFromSpec(a[0]);
      const bundle = await exportBackend(b);
      const json = JSON.stringify(bundle, null, 2);
      const outFlag = a.indexOf("--out");
      if (outFlag !== -1 && a[outFlag + 1]) {
        await writeFile(a[outFlag + 1], json);
        console.log(`exported ${bundle.versions.length} versions + ${bundle.labels.length} labels -> ${a[outFlag + 1]}`);
      } else {
        console.log(json);
      }
      return 0;
    }
    case "import": {
      const b = backendFromSpec(a[0]);
      const bundle = JSON.parse(await readFile(a[1], "utf8")) as StoreBundle;
      await importBundle(b, bundle);
      console.log(`imported ${bundle.versions.length} versions + ${bundle.labels.length} labels`);
      return 0;
    }
    case "migrate": {
      const report = await migrate(backendFromSpec(a[0]), backendFromSpec(a[1]));
      console.log(JSON.stringify(report, null, 2));
      return report.hashMismatches.length || report.missingOnTarget.length ? 1 : 0;
    }
    case "seed":
    case "sync":
    case "add":
      console.error(`"${verb}" is domain-specific (needs the domain's hash/defaults) — use the ADW seed-prompts / seed-scaffolds scripts, or the library API. The generic CLI covers backend-level verbs.`);
      return 2;
    default:
      console.error(USAGE);
      return verb ? 2 : 0;
  }
}
