#!/usr/bin/env node
// Refuse to publish a build that carries internal references.
//
// The repository already scans staged diffs for these, and that check passed every time: the lines were never
// wrong as SOURCE. They became a problem only once the build carried them into the package, where one of them
// was printed to a public user's terminal telling them to run scripts in a repository they cannot open. Nothing
// inspected the built artifact, so this does.
//
// Run against dist/ after a build, and in CI before publish.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKSLASH = String.fromCharCode(92);

// Internal project names, hostnames and this project's own tracker ids. Word-bounded where a bare substring
// would produce false positives: "adw" appears inside ordinary words, "ADW" as a standalone token does not.
const FORBIDDEN = [
  { re: /\bADW\b/, what: "an internal project name" },
  { re: /\bBEPA\b/, what: "an internal project name" },
  { re: /\bDealParley\b|\bSalesCoach\b/, what: "an internal project name" },
  { re: /\bnurserver\b|\bhetserver\b/, what: "an internal hostname" },
  { re: /TD-VS-\d+/, what: "an internal tech-debt id" },
];

// Absolute paths, checked as substrings so the backslashes need no escaping dance.
const FORBIDDEN_SUBSTRINGS = [
  { needle: ":" + BACKSLASH + "Codes" + BACKSLASH, what: "a local absolute path" },
  { needle: "/home/ubuntu/", what: "a server absolute path" },
];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|cjs|ts|json|md)$/.test(entry)) yield p;
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: check-dist-clean.mjs <dir> [dir...]");
  process.exit(2);
}

let failures = 0;
for (const root of roots) {
  let listing;
  try {
    listing = [...files(root)];
  } catch {
    console.error(`cannot read ${root}: build it first`);
    process.exit(2);
  }
  for (const file of listing) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { re, what } of FORBIDDEN) {
        if (re.test(line)) {
          console.error(`${file}:${i + 1}: ${what}: ${line.trim().slice(0, 140)}`);
          failures++;
        }
      }
      for (const { needle, what } of FORBIDDEN_SUBSTRINGS) {
        if (line.includes(needle)) {
          console.error(`${file}:${i + 1}: ${what}: ${line.trim().slice(0, 140)}`);
          failures++;
        }
      }
    });
  }
}

if (failures > 0) {
  console.error(`\n${failures} internal reference(s) in the built output. These ship to consumers. Fix the source.`);
  process.exit(1);
}
console.log("dist is clean of internal references");
