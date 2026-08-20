// The dist-tag this reconciles is DERIVED from the version being published, not hardcoded. It used to be
// the literal string "alpha", which was correct for the whole alpha line and quietly wrong the moment the
// first beta shipped: it advanced the `alpha` tag onto a beta, so anyone pinned to `@alpha` would have been
// handed a beta they never opted into. A prerelease's channel is the identifier in its version, so read it
// from there and the script keeps working for beta, rc, or anything after.
function channelOf(version) {
  const pre = /-([0-9A-Za-z]+)\./.exec(version);
  return pre ? pre[1] : null;
}

// Post-publish dist-tag reconciliation for the alpha line.
//
// Why this exists: `latest` is the tag npm installs when a user types `npm install @versioned-store/core`
// with no version. While the project is pre-1.0 and shipping alphas, `latest` must NEVER point at a
// prerelease, or every new consumer silently installs an alpha they did not ask for. Conversely `alpha` must
// point at the newest prerelease, or `npm install @versioned-store/core@alpha` serves a stale one.
//
// `changeset publish` in pre mode is expected to publish under the pre tag, so on a clean run this script is
// a no-op that proves the expectation held. It is the assertion, not the mechanism: the value is that it
// moves the tag or FAILS LOUDLY on the release turn, instead of a consumer discovering the drift later.
// It is idempotent and safe to re-run.
//
// Registry read-lag (the reason reconcile does NOT gate on a read): immediately after `changeset publish`,
// `npm view <name> dist-tags` frequently returns a cached 404 because the public read replicas lag the
// authenticated write by up to a minute or two. A single 404 is therefore NOT proof the package is
// unpublished. In reconcile mode the WRITE is authoritative: `npm dist-tag add name@version alpha` succeeds
// iff the version is live, so we attempt it unconditionally and read only best-effort for the report. Only
// `--check` (which mutates nothing) relies on the read, and it retries with backoff.
//
//   node scripts/retag-alpha.mjs           # reconcile: point `alpha` at each package's current version
//   node scripts/retag-alpha.mjs --check   # verify only, mutate nothing, exit 1 on drift (CI / dry-run)

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CHECK_ONLY = process.argv.includes("--check");
const ROOT = new URL("../", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPrerelease = (v) => v.includes("-");

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

// Run through a shell (execSync), NOT execFileSync. This release is run manually from the maintainer's Windows
// box (there is no CI publish job), where `npm` is `npm.cmd`: `execFileSync("npm", ...)` looks for a literal
// `npm` executable and throws ENOENT, and naming `npm.cmd` is blocked by Node's CVE-2024-27980 `.cmd`-spawn
// guard unless a shell is used. That made every read throw, so the script reported "not published" for every
// package and silently never moved the `alpha` tag: the real TD-VS-08 root cause, mis-attributed to registry
// read-lag. A shell resolves `npm` via PATHEXT on Windows and normally on POSIX. execSync (a command string)
// rather than execFileSync + `shell:true` avoids Node 22's DEP0190; our args are fixed shell-safe tokens
// (semver versions + scoped package names, no spaces or metacharacters), so joining them is not an injection
// surface here.
function npm(args) {
  return execSync(`npm ${args.join(" ")}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Every version on the registry for `name`, or [] if the package is unreadable / absent. */
function publishedVersions(name) {
  try {
    const raw = JSON.parse(npm(["view", name, "versions", "--json"]));
    return Array.isArray(raw) ? raw : [raw].filter(Boolean);
  } catch {
    return [];
  }
}

/** True iff the package exists at all (distinguishes a genuinely absent package from a lagging read). */
const packageExists = (name) => publishedVersions(name).length > 0;

/**
 * Read a package's dist-tags, resilient to the read replicas lagging the write. A single 404 is not proof of
 * "unpublished", so retry with exponential backoff, then fall back to a `versions` probe to tell a genuinely
 * absent package apart from a published-but-lagging one. Returns one of:
 *   { state: "ok", tags }   read succeeded
 *   { state: "absent" }     confirmed never published (dist-tags AND versions both unreadable)
 *   { state: "unreadable" } published (versions visible) but the tag read did not settle in the budget
 */
async function readDistTags(name, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      return { state: "ok", tags: JSON.parse(npm(["view", name, "dist-tags", "--json"])) };
    } catch {
      if (i < attempts - 1) await sleep(Math.min(2000 * 2 ** i, 30000)); // 2s, 4s, 8s, 16s, 30s...
    }
  }
  return { state: packageExists(name) ? "unreadable" : "absent" };
}

let drift = 0;
let reconciled = 0;

for (const { name, version } of publishablePackages()) {
  if (!isPrerelease(version)) {
    console.log(`- ${name}@${version} is not a prerelease; the alpha line does not apply`);
    continue;
  }

  // --check must rely on the read (it mutates nothing), so give it a real retry budget. Reconcile reads
  // best-effort only, for the report and the latest-guard; its write does not depend on the read.
  const read = await readDistTags(name, CHECK_ONLY ? 6 : 1);
  const tags = read.state === "ok" ? read.tags : undefined;

  // latest-on-prerelease guard: only a real regression once a STABLE version exists for latest to track.
  // For an alpha-only package, latest = the alpha is the only sensible value (it is what makes a bare
  // `npm install ${name}` resolve at all). Skipped entirely when the read did not settle.
  if (tags?.latest && isPrerelease(tags.latest)) {
    if (publishedVersions(name).some((v) => !isPrerelease(v))) {
      console.error(`! ${name}: dist-tag "latest" points at the prerelease ${tags.latest}, but a stable version exists.`);
      console.error(`  Every plain "npm install ${name}" now serves an alpha. Repoint latest at the stable:`);
      console.error(`  npm dist-tag add ${name}@<stable> latest`);
      drift++;
    } else {
      console.log(`- ${name}: latest -> ${tags.latest} (a prerelease, but no stable version exists yet; expected pre-1.0)`);
    }
  }

  if (CHECK_ONLY) {
    if (read.state === "absent") {
      console.log(`- ${name}: not published yet, nothing to check`);
    } else if (read.state === "unreadable") {
      console.error(`! ${name}: published, but its dist-tags did not settle within the read budget; cannot verify ${channelOf(version) ?? "latest"} -> ${version}.`);
      drift++;
    } else if (tags[channelOf(version) ?? "latest"] === version) {
      console.log(`- ${name}: ${channelOf(version) ?? "latest"} -> ${version} (already correct)`);
    } else {
      console.error(`! ${name}: ${channelOf(version) ?? "latest"} -> ${tags[channelOf(version) ?? "latest"] ?? "(unset)"} but this package is at ${version}`);
      drift++;
    }
    continue;
  }

  // Reconcile mode: the write is authoritative and independent of the (possibly lagging) read. Skip the
  // write only when a FRESH read already shows the tag correct; otherwise attempt it. Setting alpha to the
  // version it already holds is a harmless no-op, so a stale read never causes a wrong action. A true
  // "version not published" is the only way `dist-tag add` fails, and that is handled gracefully.
  if (read.state === "ok" && tags[channelOf(version) ?? "latest"] === version) {
    console.log(`- ${name}: ${channelOf(version) ?? "latest"} -> ${version} (already correct)`);
    continue;
  }
  try {
    npm(["dist-tag", "add", `${name}@${version}`, channelOf(version) ?? "latest"]);
    const was = read.state === "ok" ? (tags[channelOf(version) ?? "latest"] ?? "unset") : "unread (registry read lagged)";
    console.log(`+ ${name}: alpha -> ${version} (was ${was})`);
    reconciled++;
  } catch {
    console.log(`- ${name}@${version}: not published yet, nothing to reconcile`);
  }
}

if (drift > 0) {
  console.error(`\n${drift} dist-tag problem(s). ${CHECK_ONLY ? "Re-run without --check to reconcile." : "Fix before announcing."}`);
  process.exit(1);
}
console.log(`\ndist-tags OK${reconciled ? ` (${reconciled} reconciled)` : ""}.`);
