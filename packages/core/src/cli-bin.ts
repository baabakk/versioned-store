#!/usr/bin/env node
// Bin wrapper for the packaged CLI (copied to src/cli-bin.ts during extraction). Thin, so run() stays
// unit-testable with an injected clock; here it gets the real one.
import { run } from "./cli.js";

run(process.argv.slice(2), new Date().toISOString())
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
