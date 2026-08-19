// Deploy the benchmark to AWS Lambda on BOTH architectures, invoke it, collect the numbers, and delete
// everything. Nothing is left behind: two functions and one IAM role are created, then removed in a finally.
//
// Lambda is the most interesting target for this library. A hosted config service resolves over the network,
// so a cold function waits on a fetch before it can act; this store resolves from memory or /tmp, and its code
// default is compiled into the bundle, so a cold function is configured the instant it starts. Running on
// arm64 and x86_64 side by side also gets us a Graviton number for free.
//
// It drives the `aws` CLI rather than an SDK, so there is nothing to install beyond what is already here, and
// no dependency is added to a package that ships with none.
//
// Usage:  node bench/lambda/run.mjs            # plan only
//         node bench/lambda/run.mjs --confirm  # create, invoke, destroy

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIRM = process.argv.includes("--confirm");
const PKG = "@versioned-store/core@0.1.0-alpha.5";
const STAMP = Date.now().toString(36);
const ROLE = `vs-bench-role-${STAMP}`;
const ARCHES = [
  ["arm64", `vs-bench-arm64-${STAMP}`],
  ["x86_64", `vs-bench-x86-${STAMP}`],
];

const aws = (args, opts = {}) =>
  execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const awsJson = (args) => JSON.parse(aws(args) || "{}");

console.log(`\nplan: 2 Lambda functions (arm64 + x86_64) and 1 IAM role, then invoke and delete all three.`);
console.log(`  runtime  : nodejs22.x`);
console.log(`  package  : ${PKG} installed from npm (measures what a consumer installs)`);
console.log(`  cost     : Lambda free tier covers this comfortably; the role is free.`);
console.log(`  teardown : both functions and the role are deleted in a finally block.\n`);

if (!CONFIRM) {
  console.log("PLAN ONLY. re-run with --confirm to create, invoke, and destroy.\n");
  process.exit(0);
}

// ── Build the deployment package ───────────────────────────────────────────
const build = mkdtempSync(join(tmpdir(), "vs-lambda-"));
console.log(`building deployment package in ${build} ...`);
writeFileSync(join(build, "package.json"), JSON.stringify({ name: "vs-bench", type: "module", private: true }), "utf8");
execFileSync("npm", ["install", PKG, "--no-audit", "--no-fund", "--silent"], { cwd: build, stdio: "ignore", shell: process.platform === "win32" });
writeFileSync(join(build, "index.mjs"), readFileSync(join(here, "handler.mjs"), "utf8"), "utf8");

const zip = join(build, "fn.zip");
// PowerShell's Compress-Archive avoids adding a zip dependency to a zero-dependency package.
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${join(build, "*")}' -DestinationPath '${zip}' -Force`],
  { stdio: "ignore" },
);
console.log(`  packaged.`);

const results = [];
let roleArn = null;
const createdFns = [];

try {
  // ── IAM role ─────────────────────────────────────────────────────────────
  const trust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  });
  const trustFile = join(build, "trust.json");
  writeFileSync(trustFile, trust, "utf8");
  console.log(`creating IAM role ${ROLE} ...`);
  roleArn = awsJson(["iam", "create-role", "--role-name", ROLE, "--assume-role-policy-document", `file://${trustFile}`, "--output", "json"]).Role.Arn;
  aws(["iam", "attach-role-policy", "--role-name", ROLE, "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]);
  // IAM is eventually consistent: a role can exist but not yet be assumable by Lambda, which surfaces as an
  // opaque InvalidParameterValueException on create-function. Waiting here is cheaper than retry-guessing.
  console.log(`  waiting for IAM propagation ...`);
  await new Promise((r) => setTimeout(r, 12000));

  // ── functions ────────────────────────────────────────────────────────────
  for (const [arch, fn] of ARCHES) {
    console.log(`creating ${fn} (${arch}) ...`);
    let created = false;
    for (let attempt = 1; attempt <= 5 && !created; attempt++) {
      try {
        aws([
          "lambda", "create-function",
          "--function-name", fn,
          "--runtime", "nodejs22.x",
          "--architectures", arch,
          "--role", roleArn,
          "--handler", "index.handler",
          "--zip-file", `fileb://${zip}`,
          "--timeout", "120",
          "--memory-size", "1024",
          "--output", "json",
        ]);
        created = true;
        createdFns.push(fn);
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, 6000)); // still propagating
      }
    }
    aws(["lambda", "wait", "function-active-v2", "--function-name", fn]);

    // First invoke = cold start. Second = warm, on the same execution environment.
    const out1 = join(build, `${fn}-cold.json`);
    aws(["lambda", "invoke", "--function-name", fn, "--cli-binary-format", "raw-in-base64-out", "--payload", "{}", out1, "--output", "json"]);
    const cold = JSON.parse(readFileSync(out1, "utf8"));

    const out2 = join(build, `${fn}-warm.json`);
    aws(["lambda", "invoke", "--function-name", fn, "--cli-binary-format", "raw-in-base64-out", "--payload", "{}", out2, "--output", "json"]);
    const warm = JSON.parse(readFileSync(out2, "utf8"));

    results.push({ arch, cold, warm });
    console.log(`  ${arch}: init ${cold.initMicros} us, cold first resolve ${cold.coldFirstResolveMicros} us, warm p50 ${warm.warmResolveInMemory.p50} us`);
  }
} finally {
  for (const fn of createdFns) {
    try {
      aws(["lambda", "delete-function", "--function-name", fn]);
      console.log(`deleted ${fn}`);
    } catch (err) {
      console.error(`FAILED to delete ${fn}: run  aws lambda delete-function --function-name ${fn}`);
    }
  }
  if (roleArn) {
    try {
      aws(["iam", "detach-role-policy", "--role-name", ROLE, "--policy-arn", "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]);
      aws(["iam", "delete-role", "--role-name", ROLE]);
      console.log(`deleted role ${ROLE}`);
    } catch (err) {
      console.error(`FAILED to delete role ${ROLE}: run  aws iam delete-role --role-name ${ROLE}`);
    }
  }
  try {
    rmSync(build, { recursive: true, force: true });
  } catch {
    /* the temp dir is the OS's problem now */
  }
}

if (results.length) {
  const out = join(here, "results-lambda.json");
  writeFileSync(out, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nwrote ${out}`);
  console.log(`\n| arch | init (us) | cold first resolve (us) | warm resolve p50/p95 (us) | file p50 (us) |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of results) {
    console.log(
      `| ${r.arch} | ${r.cold.initMicros} | ${r.cold.coldFirstResolveMicros} | ${r.warm.warmResolveInMemory.p50} / ${r.warm.warmResolveInMemory.p95} | ${r.warm.warmResolveFile.p50} |`,
    );
  }
  console.log("");
}
