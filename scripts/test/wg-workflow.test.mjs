// wg-workflow.test.mjs
//
// Plain English: checks on .github/workflows/wg.yml that can be made without
// running it. The file must still be valid YAML (parsed with Python's yaml,
// as ci.yml does for cloud-init, when Python is there), and the live log must
// be wired in the right places: started once the callback token is known,
// copied from the steps that matter, flushed before the result is reported.
// Also the gateway's side of labs: a destroy first removes the lab peerings
// and DNS links on vnet-wg (and changes nothing when there are no labs), and
// the VM's tunnel DNS sends Azure service names to Azure's own resolver.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const WF = fileURLToPath(new URL("../../.github/workflows/wg.yml", import.meta.url));
const text = readFileSync(WF, "utf8");

/** The steps, parsed by a real YAML parser when one is available. */
function parsedSteps() {
  for (const py of ["python3", "python"]) {
    const r = spawnSync(py, ["-c", "import sys, json, yaml; d = yaml.safe_load(open(sys.argv[1], encoding='utf-8')); print(json.dumps(d['jobs']['terraform']['steps']))", WF], { encoding: "utf8" });
    if (r.status === 0) return JSON.parse(r.stdout);
    if (r.stderr && /yaml|Error/.test(r.stderr) && !/No module named|not found|not recognized/.test(r.stderr)) throw new Error(`wg.yml does not parse: ${r.stderr}`);
  }
  return null;
}
const steps = parsedSteps();
const noYaml = steps ? false : "no Python with PyYAML here";

/** Steps whose output goes to the live log. */
const STREAMED = ["Wait for any earlier wg run to finish", "terraform init (state in R2)", "terraform apply", "Remove lab peerings", "terraform destroy", "Verify Azure is clean (fallback delete)", "Park DNS record", "Back up state"];

test("wg.yml has no tabs and every step still has a name", () => {
  assert.ok(!text.includes("\t"));
  const names = [...text.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  for (const n of [...STREAMED, "Start live log", "Finish live log", "Report result to the Worker"]) assert.ok(names.includes(n), `missing step ${n}`);
});

test("wg.yml parses as YAML", { skip: noYaml }, () => {
  assert.ok(Array.isArray(steps) && steps.length > 10);
});

test("the live log starts once the run's callback token is known, and never fails the job", { skip: noYaml }, () => {
  const names = steps.map((s) => s.name);
  const start = steps.find((s) => s.name === "Start live log");
  assert.ok(names.indexOf("Start live log") > names.indexOf("Collect run secrets from the Worker"));
  assert.ok(names.indexOf("Start live log") < names.indexOf("Wait for any earlier wg run to finish"));
  assert.equal(start["continue-on-error"], true);
  assert.match(start.if, /CALLBACK_TOKEN/);
  assert.match(start.run, /live-log\.mjs" ship/);
  assert.match(start.run, /nohup/);
  assert.match(start.run, /LIVE_LOG_FILE=.*GITHUB_ENV/);
  assert.match(start.run, /LIVE_LOG_PID=.*GITHUB_ENV/);
  // It gets no repository secrets of its own.
  assert.equal(start.env, undefined);
});

test("each step that matters copies its output into the live log under its own name, first thing", { skip: noYaml }, () => {
  for (const name of STREAMED) {
    const s = steps.find((x) => x.name === name);
    const first = s.run.split("\n")[0];
    assert.equal(first, `source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "${name}"`, name);
  }
});

test("the last lines are sent before the result is reported, even after a failure, and the shipper is stopped", { skip: noYaml }, () => {
  const names = steps.map((s) => s.name);
  const fin = steps.find((s) => s.name === "Finish live log");
  assert.ok(names.indexOf("Finish live log") > names.indexOf("Back up state"));
  assert.ok(names.indexOf("Finish live log") < names.indexOf("Report result to the Worker"));
  assert.match(fin.if, /always\(\)/);
  assert.equal(fin["continue-on-error"], true);
  assert.match(fin.run, /\.stop/);
  assert.match(fin.run, /kill/);
});

// ── Labs: "Remove lab peerings" before the gateway goes ──────────────────
// A lab peered with the gateway has a peering on vnet-wg, and maybe private
// DNS links to it from the lab's zones. A destroy removes those first (they
// are the labs', not Terraform's) and tells the Worker, which marks the lab
// sessions "disconnected". With no labs it only looks; and nothing it does,
// not even a failure, can stop the gateway being destroyed.

const LAB_STEP = "Remove lab peerings";

test("Remove lab peerings is the first destroy step after secrets, and a failure never stops the destroy", { skip: noYaml }, () => {
  const names = steps.map((s) => s.name);
  const at = names.indexOf(LAB_STEP);
  const step = steps[at];
  assert.ok(at >= 0, "missing step");
  assert.equal(step.if, "inputs.action == 'destroy'");
  // After the run's secrets and after any earlier wg run has finished, so it
  // never races an apply; before anything is destroyed.
  assert.ok(at > names.indexOf("Collect run secrets from the Worker"));
  assert.ok(at > names.indexOf("Wait for any earlier wg run to finish"));
  assert.ok(at < names.indexOf("terraform destroy"));
  const firstDestroy = steps.findIndex((s) => typeof s.if === "string" && s.if.includes("'destroy'"));
  assert.equal(firstDestroy, at, "it is the first destroy step");
  // Never fatal: continue-on-error, a short timeout (the job has 40 minutes in
  // all), -e switched off (GitHub runs steps with bash -e) and a plain exit 0.
  assert.equal(step["continue-on-error"], true);
  assert.ok(step["timeout-minutes"] > 0 && step["timeout-minutes"] <= 5, "a short timeout");
  assert.match(step.run, /^set \+e /m);
  assert.match(step.run.trimEnd(), /\nexit 0$/);
  // The steps after it still run on destroy whatever it did.
  for (const n of ["terraform destroy", "Verify Azure is clean (fallback delete)", "Park DNS record"]) {
    assert.equal(steps.find((s) => s.name === n).if, "inputs.action == 'destroy'", n);
  }
});

test("Remove lab peerings sees the Azure login and the resource group only: never the DNS token, WireGuard key or state keys", { skip: noYaml }, () => {
  const step = steps.find((s) => s.name === LAB_STEP);
  assert.deepEqual(Object.keys(step.env).sort(), ["ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_SUBSCRIPTION_ID", "ARM_TENANT_ID", "RG"]);
  assert.equal(step.env.RG, "${{ secrets.AZURE_RESOURCE_GROUP }}");
  // The script runs as written: no GitHub expressions inside it.
  assert.ok(!step.run.includes("${{"), "no ${{ }} in the script");
});

// The step's script, run for real under bash with a fake az and curl that
// record every call. Needs bash and jq (CI has both; Git Bash lacks jq).
function findBash() {
  const cands = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash"] : ["bash"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "command -v jq >/dev/null && echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
const BASH = steps ? findBash() : null;
const noBash = noYaml || (BASH ? false : "no bash with jq here");
const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");

const SUB = "00000000-1111-2222-3333-444444444444";
const WG_VNET = `/subscriptions/${SUB}/resourceGroups/rg-wg-ondemand/providers/Microsoft.Network/virtualNetworks/vnet-wg`;
const labVnet = (rg, name = "vnet-lab") => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${name}`;

const FAKE_AZ = `#!/usr/bin/env bash
# Records each call, answers from files in $FAKE.
printf 'az %s\\n' "$*" >> "$FAKE/calls"
case "$*" in
  "login "*) exit "$(cat "$FAKE/login_exit" 2>/dev/null || echo 0)" ;;
  "account set "*) exit 0 ;;
  "group exists "*) cat "$FAKE/group_exists" 2>/dev/null || echo true ;;
  "network vnet peering list "*) if [ -f "$FAKE/peerings" ]; then cat "$FAKE/peerings"; else echo "ERROR: vnet not found" >&2; exit 3; fi ;;
  "network vnet peering delete "*|"network private-dns link vnet delete "*)
    for n in $(cat "$FAKE/fail_delete" 2>/dev/null); do case " $* " in *" -n $n "*) exit 1 ;; esac; done ;;
  "network private-dns zone list "*) cat "$FAKE/zones" 2>/dev/null || echo "[]" ;;
  "network private-dns link vnet list "*)
    z="$(sed -E 's/.* -z ([^ ]+).*/\\1/' <<<"$*")"
    cat "$FAKE/links-$z" 2>/dev/null || echo "[]" ;;
  *) echo "fake az: unexpected call: $*" >&2; exit 9 ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE/calls"
while [ $# -gt 0 ]; do
  case "$1" in -d) printf '%s' "$2" > "$FAKE/body"; shift ;; -H) printf '%s\\n' "$2" >> "$FAKE/headers"; shift ;; esac
  shift
done
code="$(cat "$FAKE/http" 2>/dev/null || echo 200)"
printf '%s' "$code"
[ "$code" = "000" ] && exit 7
exit 0
`;

/** Run the step's script as GitHub would (bash -e, pipefail), against a fake Azure described by `azure`. */
function runLabStep(azure = {}, env = {}) {
  const fake = mkdtempSync(join(tmpdir(), "wg-lab-step-")).replace(/\\/g, "/");
  const bin = `${fake}/bin`;
  mkdirSync(bin);
  writeFileSync(`${bin}/az`, FAKE_AZ);
  writeFileSync(`${bin}/curl`, FAKE_CURL);
  chmodSync(`${bin}/az`, 0o755);
  chmodSync(`${bin}/curl`, 0o755);
  writeFileSync(`${fake}/calls`, "");
  for (const [k, v] of Object.entries(azure)) writeFileSync(`${fake}/${k}`, typeof v === "string" ? v : JSON.stringify(v));
  const step = steps.find((s) => s.name === LAB_STEP);
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${process.platform === "win32" ? bin.replace(/\//g, "\\") : bin}${delimiter}${process.env.PATH}`,
      FAKE: fake,
      GITHUB_WORKSPACE: ROOT,
      LIVE_LOG_FILE: "",
      RUNNER_TEMP: fake,
      ARM_CLIENT_ID: "client",
      ARM_CLIENT_SECRET: "secret",
      ARM_TENANT_ID: "tenant",
      ARM_SUBSCRIPTION_ID: SUB,
      RG: "rg-wg-ondemand",
      WORKER_RUN_ID: "run-destroy-1",
      CALLBACK_URL: "https://wg-admin.example.net/api/callback",
      CALLBACK_TOKEN: "cbtoken",
      ...env,
    },
  });
  const calls = readFileSync(`${fake}/calls`, "utf8").split("\n").filter(Boolean);
  const body = existsSync(`${fake}/body`) ? JSON.parse(readFileSync(`${fake}/body`, "utf8")) : null;
  const headers = existsSync(`${fake}/headers`) ? readFileSync(`${fake}/headers`, "utf8") : "";
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), calls, body, headers };
}
const deletes = (calls) => calls.filter((c) => / delete /.test(c));

test("with no labs, Remove lab peerings only looks: nothing is deleted and the destroy goes on", { skip: noBash }, () => {
  const r = runLabStep({ peerings: [], zones: [] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(deletes(r.calls), []);
  assert.ok(!/::warning::/.test(r.out), r.out);
  // Only lists: no zone in a lab group means no further calls.
  assert.deepEqual(r.calls.filter((c) => c.startsWith("az network")).map((c) => c.split(" -")[0]), ["az network vnet peering list", "az network private-dns zone list"]);
  assert.deepEqual(r.body, { run_id: "run-destroy-1", peerings_removed: 0, dns_links_removed: 0, complete: true });
});

test("Remove lab peerings deletes only peerings to rg-lab- networks and lab DNS links to vnet-wg, then tells the Worker", { skip: noBash }, () => {
  const r = runLabStep({
    peerings: [
      { name: "wg-to-lab-az104-06", remoteVirtualNetwork: { id: labVnet("rg-lab-az104-06-blob-security") } },
      { name: "wg-to-lab-07", remoteVirtualNetwork: { id: labVnet("RG-LAB-AZ104-07-FILES", "vnet-hub") } },
      { name: "to-something-else", remoteVirtualNetwork: { id: labVnet("rg-home-site") } },
    ],
    zones: [
      { name: "privatelink.blob.core.windows.net", resourceGroup: "rg-lab-az104-06-blob-security" },
      { name: "privatelink.blob.core.windows.net", resourceGroup: "rg-other" },
    ],
    "links-privatelink.blob.core.windows.net": [
      { name: "to-lab-vnet", virtualNetwork: { id: labVnet("rg-lab-az104-06-blob-security") } },
      { name: "to-wg", virtualNetwork: { id: WG_VNET.toLowerCase() } },
    ],
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(deletes(r.calls), [
    "az network vnet peering delete -g rg-wg-ondemand --vnet-name vnet-wg -n wg-to-lab-az104-06 -o none",
    "az network vnet peering delete -g rg-wg-ondemand --vnet-name vnet-wg -n wg-to-lab-07 -o none",
    "az network private-dns link vnet delete -g rg-lab-az104-06-blob-security -z privatelink.blob.core.windows.net -n to-wg --yes -o none",
  ]);
  // The other group's zone is never even read.
  assert.ok(!r.calls.some((c) => c.includes("-g rg-other")), r.calls.join("\n"));
  // Then the Worker hears, with the gateway run's callback token.
  const curl = r.calls.findIndex((c) => c.startsWith("curl "));
  assert.ok(curl > r.calls.findLastIndex((c) => / delete /.test(c)), "the Worker is told after the deletes");
  assert.match(r.calls[curl], /-X POST/);
  assert.match(r.calls[curl], / https:\/\/wg-admin\.example\.net\/api\/callback\/lab-peerings-removed$/);
  assert.match(r.headers, /^Authorization: Bearer cbtoken$/m);
  assert.deepEqual(r.body, { run_id: "run-destroy-1", peerings_removed: 2, dns_links_removed: 1, complete: true });
});

test("a failure in Remove lab peerings is a warning, the Worker is still told, and the step ends 0", { skip: noBash }, () => {
  const failedDelete = runLabStep({
    peerings: [{ name: "wg-to-lab-a", remoteVirtualNetwork: { id: labVnet("rg-lab-a") } }, { name: "wg-to-lab-b", remoteVirtualNetwork: { id: labVnet("rg-lab-b") } }],
    zones: [],
    fail_delete: "wg-to-lab-a",
  });
  assert.equal(failedDelete.status, 0, failedDelete.out);
  assert.match(failedDelete.out, /::warning::.*wg-to-lab-a/);
  assert.deepEqual(failedDelete.body, { run_id: "run-destroy-1", peerings_removed: 1, dns_links_removed: 0, complete: false });

  const noLogin = runLabStep({ login_exit: "1" });
  assert.equal(noLogin.status, 0, noLogin.out);
  assert.match(noLogin.out, /::warning::/);
  assert.deepEqual(deletes(noLogin.calls), []);
  assert.equal(noLogin.body.complete, false);

  const workerDown = runLabStep({ peerings: [], zones: [], http: "000" });
  assert.equal(workerDown.status, 0, workerDown.out);
  assert.match(workerDown.out, /::warning::.*Worker/);
});

test("Remove lab peerings: a gateway already gone, a manual run and a Worker without labs are all quiet", { skip: noBash }, () => {
  const gone = runLabStep({ group_exists: "false", zones: [] });
  assert.equal(gone.status, 0, gone.out);
  assert.ok(!gone.calls.some((c) => c.includes("vnet peering")), "no peering calls when the group is gone");
  assert.ok(!/::warning::/.test(gone.out), gone.out);
  assert.equal(gone.body.complete, true);

  const manual = runLabStep({ peerings: [], zones: [] }, { CALLBACK_URL: "", CALLBACK_TOKEN: "" });
  assert.equal(manual.status, 0, manual.out);
  assert.ok(!manual.calls.some((c) => c.startsWith("curl ")), "no callback on a manual run");

  // Today's Worker has no lab routes: a 404 is a note, not a warning.
  const old = runLabStep({ peerings: [], zones: [], http: "404" });
  assert.equal(old.status, 0, old.out);
  assert.ok(!/::warning::/.test(old.out), old.out);
});

// ── Labs: tunnel DNS ─────────────────────────────────────────────────────
// Clients using the tunnel DNS reach a lab's private endpoint by name: names
// under Azure's service domains go to Azure DNS (168.63.129.16), which
// answers public names as before and private ones from lab zones linked to
// vnet-wg. Every other name still goes to Cloudflare, exactly as before.

const TPL = readFileSync(fileURLToPath(new URL("../../infra/cloud-init.yaml.tftpl", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
/** The dnsmasq config the VM gets, as dnsmasq reads it (template values still in place). */
function dnsmasqConf() {
  const at = TPL.indexOf("  - path: /etc/dnsmasq.d/wg-admin.conf\n");
  assert.ok(at >= 0, "no dnsmasq config in cloud-init");
  const block = TPL.slice(at, TPL.indexOf("\n  - path:", at + 1));
  const body = block.slice(block.indexOf("    content: |\n") + "    content: |\n".length);
  return body.split("\n").map((l) => l.replace(/^ {6}/, ""));
}
const AZURE_DOMAINS = ["core.windows.net", "database.windows.net", "azurewebsites.net", "vaultcore.azure.net", "documents.azure.com", "servicebus.windows.net", "internal"];

test("cloud-init forwards the seven Azure domains to 168.63.129.16", () => {
  const conf = dnsmasqConf();
  const servers = conf.filter((l) => l.startsWith("server="));
  const azure = servers.filter((l) => l.endsWith("168.63.129.16"));
  assert.deepEqual(azure, AZURE_DOMAINS.map((d) => `server=/${d}/168.63.129.16`));
  // Everything else is unchanged: the same upstreams, still no resolv.conf.
  assert.deepEqual(servers.filter((l) => !azure.includes(l)), ["server=1.1.1.1", "server=1.0.0.1", "server=2606:4700:4700::1111"]);
  for (const l of ["no-resolv", "domain-needed", "bogus-priv", "local=/wg/", "bind-dynamic"]) assert.ok(conf.includes(l), l);
  // Private answers are not filtered out (that would hide the private endpoints).
  assert.ok(!conf.some((l) => /^stop-dns-rebind|^rebind-/.test(l)));
});

test("dnsmasq accepts the tunnel DNS config", { skip: spawnSync("dnsmasq", ["--version"]).status === 0 ? false : "no dnsmasq here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wg-dnsmasq-"));
  const conf = dnsmasqConf().join("\n").replaceAll("${loopback_ip}", "10.13.255.1").replaceAll("${wg_server_ip}", "10.13.13.1");
  writeFileSync(join(dir, "wg-admin.conf"), conf);
  const r = spawnSync("dnsmasq", ["--test", `--conf-file=${join(dir, "wg-admin.conf")}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
