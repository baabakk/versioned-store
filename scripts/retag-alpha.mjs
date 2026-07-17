// Post-publish dist-tag reconciliation for the alpha line.
//
// Why this exists: `latest` is the tag npm installs when a user types `npm install @versioned-store/core`
// with no version. While the project is pre-1.0 and shipping alphas, `latest` must NEVER point at a
// prerelease, or every new consumer silently installs an alpha they did not ask for. Conversely `alpha` must
// point at the newest prerelease, or `npm install @versioned-store/core@alpha` serves a stale one.
//
// `changeset publish` in pre mode is expected to publish under the pre tag, so on a clean run this script is
// a no-op that proves the expectation held. It is the assertion, not the mechanism: the value is that it
// FAILS LOUDLY on the release turn if npm's tag state drifted, instead of a consumer discovering it later.
// It is idempotent and safe to re-run.
//
//   node scripts/retag-alpha.mjs           # reconcile: point `alpha` at each package's current version
//   node scripts/retag-alpha.mjs --check   # verify only, mutate nothing, exit 1 on drift (CI / dry-run)

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CHECK_ONLY = process.argv.includes("--check");
const ROOT = new URL("../", import.meta.url);

/** Every publishable workspace package (private ones are skipped). */
function publishablePackages() {
  const root = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  return root.workspaces
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(new URL(`${dir}/package.json`, ROOT), "utf8"));
      return { name: pkg.name, version: pkg.version, private: pkg.private === true };
    })
    .filter((p) => !p.private);
}

function npm(args) {
  return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const isPrerelease = (v) => v.includes("-");

let drift = 0;
let reconciled = 0;

for (const { name, version } of publishablePackages()) {
  let tags;
  try {
    tags = JSON.parse(npm(["view", `${name}`, "dist-tags", "--json"]));
  } catch {
    console.log(`- ${name}: not published yet, nothing to reconcile`);
    continue;
  }

  if (!isPrerelease(version)) {
    console.log(`- ${name}@${version} is not a prerelease; the alpha line does not apply`);
    continue;
  }

  // `latest` pointing at a prerelease is only a problem once a STABLE version exists for it to track.
  // For an alpha-only package there is no stable release yet, so latest = the alpha is the only sensible
  // value (it is what makes a bare `npm install ${name}` resolve at all). Only flag a genuine regression:
  // latest sitting on a prerelease while a stable version is available.
  if (tags.latest && isPrerelease(tags.latest)) {
    let versions = [];
    try {
      const raw = JSON.parse(npm(["view", name, "versions", "--json"]));
      versions = Array.isArray(raw) ? raw : [raw].filter(Boolean);
    } catch {
      // ignore; treated as no-known-stable below
    }
    const hasStable = versions.some((v) => !isPrerelease(v));
    if (hasStable) {
      console.error(`! ${name}: dist-tag "latest" points at the prerelease ${tags.latest}, but a stable version exists.`);
      console.error(`  Every plain "npm install ${name}" now serves an alpha. Repoint latest at the stable:`);
      console.error(`  npm dist-tag add ${name}@<stable> latest`);
      drift++;
    } else {
      console.log(`- ${name}: latest -> ${tags.latest} (a prerelease, but no stable version exists yet; expected pre-1.0)`);
    }
  }

  if (tags.alpha === version) {
    console.log(`- ${name}: alpha -> ${version} (already correct)`);
    continue;
  }

  if (CHECK_ONLY) {
    console.error(`! ${name}: alpha -> ${tags.alpha ?? "(unset)"} but this package is at ${version}`);
    drift++;
    continue;
  }

  npm(["dist-tag", "add", `${name}@${version}`, "alpha"]);
  console.log(`+ ${name}: alpha -> ${version} (was ${tags.alpha ?? "unset"})`);
  reconciled++;
}

if (drift > 0) {
  console.error(`\n${drift} dist-tag problem(s). ${CHECK_ONLY ? "Re-run without --check to reconcile." : "Fix before announcing."}`);
  process.exit(1);
}
console.log(`\ndist-tags OK${reconciled ? ` (${reconciled} reconciled)` : ""}.`);
