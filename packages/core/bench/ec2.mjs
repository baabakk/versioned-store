// Ephemeral EC2 benchmark: launch throwaway instances, run the portable benchmark, collect, terminate.
//
// WHY EC2 when Lambda and Hetzner numbers already exist: this is the only CONTROLLED silicon comparison
// available. c7i (Intel Sapphire Rapids), c7a (AMD Genoa), and c7g (Graviton3) are the same generation, the
// same size class, and the same region, so the vendor is the only variable. The Hetzner rows are useful but
// cross-generation (Xeon Skylake is 2017 silicon, EPYC Milan is 2021), and Lambda allocates CPU in proportion
// to memory, so neither answers "how does this store perform on current server hardware" cleanly. This does.
//
// Same safety posture as the Hetzner runner: nothing without --confirm, everything tagged, termination in a
// finally block, and a --cleanup mode for anything an interrupted run leaves behind.
//
// Usage:  node bench/ec2.mjs                       # plan only
//         node bench/ec2.mjs --confirm             # launch, benchmark, terminate
//         node bench/ec2.mjs --cleanup             # kill anything left behind

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const TAG = "vs-bench";
const STAMP = Date.now().toString(36);
const REGION = flag("region", "us-west-2");
const KEYNAME = `${TAG}-key-${STAMP}`;
const SGNAME = `${TAG}-sg-${STAMP}`;
const IDENTITY = flag("identity", `${process.env.HOME ?? process.env.USERPROFILE}/.ssh/vs_bench_hetzner`);
const PKG = "@versioned-store/core@0.1.0-alpha.5";

// Same generation, same size, three vendors: the whole point of this run.
const TYPES = (flag("types", "c7i.large,c7a.large,c7g.large")).split(",").map((s) => s.trim());
const ARCH_OF = (t) => (t.startsWith("c7g") || t.startsWith("c6g") || t.startsWith("m7g") ? "arm64" : "x86_64");

const aws = (args) =>
  execFileSync("aws", ["--region", REGION, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const awsJson = (args) => JSON.parse(aws([...args, "--output", "json"]) || "{}");

// ── cleanup ────────────────────────────────────────────────────────────────
if (has("cleanup")) {
  const r = awsJson(["ec2", "describe-instances", "--filters", `Name=tag:Purpose,Values=${TAG}`, "Name=instance-state-name,Values=pending,running,stopping,stopped"]);
  const ids = r.Reservations.flatMap((x) => x.Instances).map((i) => i.InstanceId);
  if (ids.length) {
    aws(["ec2", "terminate-instances", "--instance-ids", ...ids]);
    console.log(`terminating ${ids.length}: ${ids.join(", ")}`);
  } else console.log("no leftover benchmark instances.");
  // Key pairs and security groups are free but untidy; sweep any this tool made.
  for (const kp of (awsJson(["ec2", "describe-key-pairs"]).KeyPairs ?? []).filter((k) => k.KeyName.startsWith(`${TAG}-key-`))) {
    try { aws(["ec2", "delete-key-pair", "--key-name", kp.KeyName]); console.log(`deleted key ${kp.KeyName}`); } catch { /* in use */ }
  }
  process.exit(0);
}

console.log(`\nplan: ${TYPES.length} throwaway EC2 instance(s) in ${REGION}`);
for (const t of TYPES) console.log(`  ${t.padEnd(12)} ${ARCH_OF(t)}`);
console.log(`  image    : Amazon Linux 2023 (latest, resolved per architecture from SSM)`);
console.log(`  package  : ${PKG} from npm (measures what a consumer installs)`);
console.log(`  cost     : roughly USD 0.26/hr combined; a run is ~10 min, so a few cents.`);
console.log(`  teardown : instances terminated in a finally block; --cleanup sweeps leftovers.\n`);
if (!has("confirm")) {
  console.log("PLAN ONLY. re-run with --confirm.\n");
  process.exit(0);
}

// ── AMIs (resolved live; hardcoding an AMI id rots and is region specific) ──
const amiFor = (arch) =>
  awsJson(["ssm", "get-parameter", "--name", `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`]).Parameter.Value;
const AMI = { x86_64: amiFor("x86_64"), arm64: amiFor("arm64") };
console.log(`resolved AMIs: x86_64=${AMI.x86_64}  arm64=${AMI.arm64}`);

// ── user-data: install node, install the published package, run, mark DONE ──
const portable = readFileSync(join(here, "portable.mjs"), "utf8");
const userData = (type) => `#!/bin/bash
set -x
mkdir -p /root/bench && cd /root/bench
echo '{"type":"module"}' > package.json
echo '${Buffer.from(portable, "utf8").toString("base64")}' | base64 -d > portable.mjs
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
npm install ${PKG} --no-audit --no-fund
node portable.mjs --label "ec2 ${type}" > bench.log 2>&1
touch /root/bench/DONE
`;

const launched = [];
const results = [];
let sgId = null;

try {
  // Reuse the existing benchmark keypair rather than generating another private key to look after.
  const pub = readFileSync(`${IDENTITY}.pub`, "utf8").trim();
  aws(["ec2", "import-key-pair", "--key-name", KEYNAME, "--public-key-material", `fileb://${IDENTITY}.pub`]);
  console.log(`imported key pair ${KEYNAME}`);

  const vpc = awsJson(["ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true"]).Vpcs[0];
  if (!vpc) throw new Error("no default VPC in this region; pass --region one that has one");
  sgId = awsJson(["ec2", "create-security-group", "--group-name", SGNAME, "--description", "versioned-store benchmark, temporary", "--vpc-id", vpc.VpcId]).GroupId;
  // Lock SSH to this machine's public address rather than the internet.
  const myIp = (await (await fetch("https://checkip.amazonaws.com")).text()).trim();
  aws(["ec2", "authorize-security-group-ingress", "--group-id", sgId, "--protocol", "tcp", "--port", "22", "--cidr", `${myIp}/32`]);
  console.log(`created security group ${SGNAME} (SSH restricted to ${myIp}/32)`);

  for (const type of TYPES) {
    const arch = ARCH_OF(type);
    try {
      const r = awsJson([
        "ec2", "run-instances",
        "--image-id", AMI[arch],
        "--instance-type", type,
        "--key-name", KEYNAME,
        "--security-group-ids", sgId,
        "--count", "1",
        "--user-data", userData(type),
        "--tag-specifications", `ResourceType=instance,Tags=[{Key=Purpose,Value=${TAG}},{Key=Name,Value=${TAG}-${type}}]`,
      ]);
      const inst = r.Instances[0];
      launched.push({ type, arch, id: inst.InstanceId });
      console.log(`launched ${type} (${arch}) -> ${inst.InstanceId}`);
    } catch (err) {
      // A type unavailable in this region/AZ must not strand the instances already launched.
      console.error(`  SKIPPED ${type}: ${String(err.stderr ?? err.message).split("\n")[0].slice(0, 160)}`);
    }
  }
  if (!launched.length) throw new Error("nothing launched");

  console.log(`\nwaiting for instances to reach running ...`);
  aws(["ec2", "wait", "instance-running", "--instance-ids", ...launched.map((l) => l.id)]);
  const desc = awsJson(["ec2", "describe-instances", "--instance-ids", ...launched.map((l) => l.id)]);
  for (const inst of desc.Reservations.flatMap((x) => x.Instances)) {
    const l = launched.find((x) => x.id === inst.InstanceId);
    l.ip = inst.PublicIpAddress;
  }

  const ssh = (ip, cmd) =>
    execFileSync("ssh", ["-i", IDENTITY, "-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=8", `ec2-user@${ip}`, cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  console.log(`waiting for benchmarks (node install + npm install + run) ...`);
  const deadline = Date.now() + 15 * 60 * 1000;
  for (const l of launched) {
    let done = false;
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15000));
      try {
        ssh(l.ip, "sudo test -f /root/bench/DONE");
        done = true;
      } catch { /* still booting or still running */ }
    }
    if (!done) { console.log(`  ${l.type}: TIMED OUT`); continue; }
    const json = ssh(l.ip, "sudo cat /root/bench/result.json");
    results.push({ instance: l.type, arch: l.arch, ...JSON.parse(json) });
    const mem = results.at(-1).results.find((r) => r.backend === "InMemory" && r.size.startsWith("small"));
    console.log(`  ${l.type}: collected (InMemory warm p50 ${mem?.warmResolve.p50} us)`);
  }
} finally {
  if (launched.length) {
    try {
      aws(["ec2", "terminate-instances", "--instance-ids", ...launched.map((l) => l.id)]);
      console.log(`\nterminating ${launched.length} instance(s) ...`);
      aws(["ec2", "wait", "instance-terminated", "--instance-ids", ...launched.map((l) => l.id)]);
      console.log(`terminated.`);
    } catch (err) {
      console.error(`FAILED to terminate. Run: node bench/ec2.mjs --cleanup`);
    }
  }
  // The security group cannot be deleted until its instances are gone, hence after the wait above.
  if (sgId) { try { aws(["ec2", "delete-security-group", "--group-id", sgId]); console.log(`deleted security group`); } catch { console.error(`could not delete SG ${sgId}`); } }
  try { aws(["ec2", "delete-key-pair", "--key-name", KEYNAME]); console.log(`deleted key pair`); } catch { /* fine */ }
}

if (results.length) {
  const out = join(here, "results-ec2.json");
  writeFileSync(out, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nwrote ${out}`);
  console.log(`\n| instance | arch | cpu | InMemory p50 | SQLite p50 | File p50 |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of results) {
    const g = (b) => r.results.find((x) => x.backend.startsWith(b) && x.size.startsWith("small"))?.warmResolve.p50 ?? "n/a";
    console.log(`| ${r.instance} | ${r.arch} | ${r.device.cpu} | ${g("InMemory")} | ${g("SQLite")} | ${g("File")} |`);
  }
  console.log("");
}
