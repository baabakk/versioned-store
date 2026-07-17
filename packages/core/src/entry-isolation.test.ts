// Regression guard: the main entry must stay driver-free and Node-18-safe.
//
// `engines: {"node": ">=18"}` is a promise that `import "@versioned-store/core"` works on Node 18. It is
// only true if the barrel's transitive import graph never reaches node:sqlite (Node 22+), pg, or mongodb.
// That promise was broken once already: index.ts re-exported ./cli.js, which statically imports the sqlite
// backend, which imports node:sqlite. Nothing failed on the maintainer's Node 24 machine, so the only
// symptom was an ExperimentalWarning nobody was looking at, while the package was unusable on the two
// engines it advertised.
//
// These tests read the SOURCE rather than importing the barrel, because an import-based check passes on
// Node 22+ regardless (node:sqlite resolves there) and would only fail on the very runtimes CI can no
// longer easily run the suite on. A static graph walk catches the leak on every Node version.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Modules that legitimately import a driver. Reaching one of these from the barrel is the bug. */
const DRIVER_MODULES = ["backends/sqlite", "backends/postgres", "backends/mongo"];
/** Bare specifiers that must never be reachable from the main entry. */
const DRIVER_SPECIFIERS = ["node:sqlite", "pg", "mongodb"];

async function importsOf(moduleRelPath: string): Promise<string[]> {
  const source = await readFile(path.join(SRC, `${moduleRelPath}.ts`), "utf8");
  // Matches `from "x"` in both static imports and re-exports. Deliberately simple: the source is ours and
  // uses plain top-level imports, so a full parse would buy nothing a regex does not already catch here.
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Walks the barrel's static import graph, returning every module and bare specifier it reaches. */
async function reachableFromEntry(): Promise<{ modules: Set<string>; specifiers: Set<string> }> {
  const modules = new Set<string>();
  const specifiers = new Set<string>();
  const queue = ["index"];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (modules.has(current)) continue;
    modules.add(current);

    for (const spec of await importsOf(current)) {
      if (!spec.startsWith(".")) {
        specifiers.add(spec);
        continue;
      }
      // Resolve the relative ESM specifier (".js" on disk is ".ts") against the importer's directory.
      const resolved = path
        .join(path.dirname(current), spec.replace(/\.js$/, ""))
        .split(path.sep)
        .join("/");
      queue.push(resolved);
    }
  }
  return { modules, specifiers };
}

describe("main entry isolation (engines: node >=18)", () => {
  it("never reaches a driver-coupled backend from the barrel", async () => {
    const { modules } = await reachableFromEntry();
    const leaked = DRIVER_MODULES.filter((m) => modules.has(m));
    assert.deepEqual(
      leaked,
      [],
      `The main entry reaches ${leaked.join(", ")}. Those are subpath-only exports: importing the barrel ` +
        `must not load their drivers. Re-export them from a subpath, not from index.ts.`,
    );
  });

  it("never imports node:sqlite, pg, or mongodb from the barrel's graph", async () => {
    const { specifiers } = await reachableFromEntry();
    const leaked = DRIVER_SPECIFIERS.filter((s) => specifiers.has(s));
    assert.deepEqual(leaked, [], `The main entry's import graph loads ${leaked.join(", ")}, breaking Node 18.`);
  });

  it("still reaches the driver-free backends, so the guard is not vacuous", async () => {
    const { modules } = await reachableFromEntry();
    for (const m of ["backends/memory", "backends/file", "backends/redis", "versionedStore"]) {
      assert.ok(modules.has(m), `expected the barrel to reach ${m}; the graph walk is not finding real edges`);
    }
  });
});
