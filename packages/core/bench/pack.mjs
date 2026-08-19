// Assemble the portable benchmark into one self-contained folder you can copy to any device.
//
// The output needs NO npm install and NO toolchain: it is the core's built dist (which imports only node:
// builtins) plus a plain-JS runner. Copy the folder to a laptop, a server, or a phone under Termux, and run
// `node portable.mjs`.
//
// Run from packages/core:  npm run bench:pack   (build first, this copies dist)

import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const dist = join(pkgRoot, "dist");
const out = join(pkgRoot, "bench-portable");

if (!existsSync(dist)) {
  console.error("packages/core/dist not found. Run `npm run build` first: the portable bench runs the BUILT core.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, join(out, "dist"), { recursive: true });
cpSync(join(here, "portable.mjs"), join(out, "portable.mjs"));

const readme = `# versioned-store portable benchmark

Self-contained. No npm install, no build tools. It needs only Node.

    node portable.mjs                          # run
    node portable.mjs --quick                  # fast smoke
    node portable.mjs --label "Pixel 8 Termux" # name this device in the output

It prints a table and writes \`result.json\`. Send that file back; several devices' results merge into
one matrix.

## Node version

Node 18 or newer. On Node 22+ the SQLite backend is included; on older Node it is skipped automatically,
because \`node:sqlite\` does not exist there. That is a supported configuration, not a failure: the core's
main entry is dependency-free and Node 18 safe by design.

## Android (Termux)

1. Install Termux from **F-Droid**, not the Play Store. The Play Store build is deprecated and stuck on an
   old version whose package repository no longer resolves.
2. \`pkg update && pkg install nodejs\`
3. Copy this folder onto the device and \`cd\` into it. If you have no cable handy, \`pkg install openssh\`
   and \`scp\` it over, or share it to Termux storage after \`termux-setup-storage\`.
4. \`node portable.mjs --label "<device name>"\`

Two things to expect on a phone, neither of which is a bug. Sustained load makes it throttle, so the tail
(p95/p99) widens the longer it runs. And on a big.LITTLE chip the scheduler may park the process on an
efficiency core, which moves the whole distribution. Run it twice; if the two runs disagree wildly, that is
the phone, not the store.

## Making the numbers comparable

- Plug in to AC power. Battery savers downclock aggressively and silently.
- Close other applications. This measures microseconds; a background sync is loud at that scale.
- Let the machine idle for a minute first if it just did something heavy (a build, an update).
- Run it twice and keep the second run. The first pays for cold filesystem caches.
`;
writeFileSync(join(out, "README.md"), readme, "utf8");

console.log(`portable benchmark packed at: ${out}`);
console.log(`  copy that folder to any device with Node, then: node portable.mjs --label "<name>"`);
