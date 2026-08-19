// Ephemeral cloud benchmark: create throwaway Hetzner instances, run the portable benchmark on each,
// collect the results, destroy everything.
//
// WHY: the published benchmark number should come from hardware anyone can reproduce. A developer laptop is
// the worst candidate (thermal throttling, hybrid P/E cores, background load); a documented cloud instance
// type is the best, because "CCX13, Nuremberg, Node 22" is a specification someone else can rent for an hour
// and check. Dedicated-vCPU types (CCX) are the reference, since shared types have steal time from neighbors.
//
// The instances need NOTHING from this repo: cloud-init installs Node, installs the PUBLISHED package from
// npm, and runs a benchmark embedded in the user-data. So this measures exactly what a consumer installs.
//
// SAFETY: instances cost money for as long as they exist. Three guards:
//   1. Nothing is created without --confirm. Without it this prints the plan and exits.
//   2. Every server is labelled `purpose=vs-bench`, so orphans are findable and killable by label.
//   3. Destruction runs in a finally block, and `--cleanup` deletes anything left behind by an earlier run
//      that died. Run --cleanup if you ever interrupt this script.
//
// Usage:
//   HCLOUD_TOKEN=... node bench/hetzner.mjs --types cx22,cax11 --ssh-key <name>          # plan only
//   HCLOUD_TOKEN=... node bench/hetzner.mjs --types cx22,cax11 --ssh-key <name> --confirm
//   HCLOUD_TOKEN=... node bench/hetzner.mjs --cleanup

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const API = "https://api.hetzner.cloud/v1";
const LABEL_KEY = "purpose";
const LABEL_VALUE = "vs-bench";
const PKG = "@versioned-store/core@0.1.0-alpha.5";

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1]?.startsWith("--") ? true : argv[i + 1]) : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const TOKEN = process.env.HCLOUD_TOKEN;
if (!TOKEN) {
  console.error(
    "HCLOUD_TOKEN is not set.\n" +
      "Create a READ+WRITE API token in the Hetzner Cloud console (Security > API tokens), for a project\n" +
      "that holds nothing you care about, then pass it via the environment. Do not paste it into a file\n" +
      "that git can see.",
  );
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    // Never echo the token; the message can carry request context but not credentials.
    throw new Error(`Hetzner API ${init.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── cleanup mode: destroy anything an interrupted run left behind ───────────
async function cleanup() {
  const { servers } = await api(`/servers?label_selector=${LABEL_KEY}%3D${LABEL_VALUE}`);
  if (servers.length === 0) {
    console.log("no leftover benchmark servers found.");
    return;
  }
  for (const s of servers) {
    console.log(`destroying leftover: ${s.name} (${s.server_type.name}, created ${s.created})`);
    await api(`/servers/${s.id}`, { method: "DELETE" });
  }
  console.log(`destroyed ${servers.length} server(s).`);
}

if (has("cleanup")) {
  await cleanup();
  process.exit(0);
}

// ── plan ───────────────────────────────────────────────────────────────────
const types = String(flag("types", "cx22")).split(",").map((s) => s.trim()).filter(Boolean);
const location = String(flag("location", "nbg1"));
const image = String(flag("image", "ubuntu-24.04"));
const sshKey = flag("ssh-key");

if (!sshKey) {
  console.error(
    "--ssh-key <name> is required: results are retrieved over SSH, so the instance needs a key you hold.\n" +
      "Use the NAME of a key already uploaded to the Hetzner project (Console > Security > SSH keys).",
  );
  process.exit(1);
}

// Pricing is fetched live rather than hardcoded, so the estimate cannot silently go stale.
const { server_types } = await api("/server_types?per_page=100");
const chosen = types.map((t) => {
  const st = server_types.find((s) => s.name === t);
  if (!st) throw new Error(`unknown server type "${t}"`);
  const price = st.prices.find((p) => p.location === location);
  return { type: t, cores: st.cores, memory: st.memory, arch: st.architecture, cpuType: st.cpu_type, hourly: Number(price?.price_hourly?.gross ?? 0) };
});

console.log(`\nplan: ${chosen.length} throwaway instance(s) in ${location}, image ${image}\n`);
for (const c of chosen) {
  console.log(`  ${c.type.padEnd(8)} ${String(c.cores).padStart(2)} vCPU ${String(c.memory).padStart(3)} GB  ${c.arch.padEnd(6)} ${c.cpuType.padEnd(9)} ~EUR ${c.hourly.toFixed(4)}/hr`);
}
const totalHourly = chosen.reduce((a, c) => a + c.hourly, 0);
console.log(`\n  benchmark takes roughly 10 minutes per instance; they run in parallel.`);
console.log(`  worst case if something hangs and you must --cleanup an hour later: ~EUR ${totalHourly.toFixed(3)}\n`);

if (!has("confirm")) {
  console.log("this was a PLAN ONLY. re-run with --confirm to actually create these instances.\n");
  process.exit(0);
}

// ── cloud-init: install node, install the published package, run the bench ──
const portable = readFileSync(join(here, "portable.mjs"), "utf8");
const userData = `#cloud-config
package_update: true
packages: [curl, ca-certificates]
write_files:
  - path: /root/bench/portable.mjs
    permissions: '0644'
    encoding: b64
    content: ${Buffer.from(portable, "utf8").toString("base64")}
  - path: /root/bench/package.json
    permissions: '0644'
    content: '{"type":"module"}'
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - cd /root/bench && npm install ${PKG} --no-audit --no-fund
  - cd /root/bench && node portable.mjs --label "hetzner $(cat /root/type)" > /root/bench/bench.log 2>&1
  - touch /root/bench/DONE
`;

const created = [];
const results = [];

try {
  for (const c of chosen) {
    const name = `vs-bench-${c.type}-${Date.now().toString(36)}`;
    console.log(`creating ${name} ...`);
    try {
      const { server } = await api("/servers", {
        method: "POST",
        body: JSON.stringify({
          name,
          server_type: c.type,
          image,
          location,
          ssh_keys: [sshKey],
          labels: { [LABEL_KEY]: LABEL_VALUE, type: c.type },
          user_data: userData.replace("$(cat /root/type)", c.type),
        }),
      });
      created.push({ ...c, id: server.id, name, ip: server.public_net.ipv4.ip });
      console.log(`  ${name} -> ${server.public_net.ipv4.ip}`);
    } catch (err) {
      // One type being unavailable (capacity, or not offered in this location) must not abandon the whole
      // sweep, and must not strand the instances already created. Report it and carry on with the rest.
      console.error(`  SKIPPED ${c.type}: ${err.message.split("\n")[0]}`);
    }
  }
  if (created.length === 0) throw new Error("no instances could be created; nothing to benchmark");

  console.log(`\nwaiting for benchmarks (cloud-init installs Node, then npm installs ${PKG}) ...`);
  const deadline = Date.now() + 20 * 60 * 1000;
  const ssh = (ip, cmd) =>
    execFileSync("ssh", ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=8", `root@${ip}`, cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  for (const s of created) {
    let done = false;
    while (!done && Date.now() < deadline) {
      await sleep(15000);
      try {
        ssh(s.ip, "test -f /root/bench/DONE");
        done = true;
      } catch {
        /* not ready: instance still booting, or the run is still going */
      }
    }
    if (!done) {
      console.log(`  ${s.name}: TIMED OUT (no result; the instance is destroyed anyway)`);
      continue;
    }
    const json = ssh(s.ip, "cat /root/bench/result.json");
    results.push({ instance: s.type, arch: s.arch, cpuType: s.cpuType, ...JSON.parse(json) });
    console.log(`  ${s.name}: collected`);
  }
} finally {
  // Always destroy, including on an error or a Ctrl-C mid-run. An instance nobody remembers is a bill.
  for (const s of created) {
    try {
      await api(`/servers/${s.id}`, { method: "DELETE" });
      console.log(`destroyed ${s.name}`);
    } catch (err) {
      console.error(`FAILED to destroy ${s.name}: ${err.message}\n  run: node bench/hetzner.mjs --cleanup`);
    }
  }
}

if (results.length) {
  const out = join(here, "results-hetzner.json");
  writeFileSync(out, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nwrote ${out} (${results.length} instance result(s))`);
}
