// Tests for the M7 versioned-store CLI (design 08 M7). Drives `run()` (the exported dispatch, with an
// injected clock) over a file backend and a file-backed sqlite, asserting exit codes + the resulting backend
// state. The CLI's console output is a side effect; the assertions are on behaviour, not stdout.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { backendFromSpec, run } from "./cli.js";

describe("M7 CLI", () => {
  test("import -> keys/versions/promote -> migrate, end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vstore-cli-"));
    const spec = `file:${dir}`;
    const bundle = {
      bundleVersion: 1,
      exportedLabels: ["active"],
      versions: [
        { key: "k", version: 1, sha256: "h1", createdAtIso: "t1", createdBy: "u", text: "one" },
        { key: "k", version: 2, sha256: "h2", createdAtIso: "t2", createdBy: "u", text: "two" },
      ],
      labels: [{ key: "k", label: "active", version: 1, promotedAtIso: "t1", promotedBy: "u" }],
    };
    const bundleFile = join(dir, "bundle.json");
    await writeFile(bundleFile, JSON.stringify(bundle));

    assert.equal(await run(["import", spec, bundleFile], "T"), 0);
    assert.equal(await run(["keys", spec], "T"), 0);
    assert.equal(await run(["versions", spec, "k"], "T"), 0);

    // promote moves the active label; verify it landed in the backend
    assert.equal(await run(["promote", spec, "k", "2"], "T"), 0);
    assert.equal((await backendFromSpec(spec).getLabel("k", "active"))?.version, 2);

    // migrate the file store into a file-backed sqlite; a clean move exits 0
    assert.equal(await run(["migrate", spec, `sqlite:${join(dir, "out.db")}`], "T"), 0);
  });

  test("promote to a non-existent version fails; unknown verb + missing verb behave", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vstore-cli2-"));
    const spec = `file:${dir}`;
    await run(["import", spec, await (async () => {
      const f = join(dir, "b.json");
      await writeFile(f, JSON.stringify({ bundleVersion: 1, exportedLabels: ["active"], versions: [{ key: "k", version: 1, sha256: "h", createdAtIso: "t", createdBy: "u" }], labels: [] }));
      return f;
    })()], "T");
    await assert.rejects(() => run(["promote", spec, "k", "99"], "T"), /does not exist/);
    assert.equal(await run(["bogus"], "T"), 2); // unknown verb -> usage, exit 2
    assert.equal(await run([], "T"), 0); // no verb -> usage, exit 0
    assert.equal(await run(["seed", spec], "T"), 2); // domain verb -> note, exit 2
  });

  test("an unsupported backend spec is a clear error", () => {
    assert.throws(() => backendFromSpec("redis:localhost"), /needs a live client/);
  });
});
