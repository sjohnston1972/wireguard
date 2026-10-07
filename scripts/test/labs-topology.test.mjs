// labs-topology.test.mjs
//
// Plain English: "npm run labs-topology" (scripts/labs-topology.mjs), the
// generator of each lab's planned diagram (lab topology spec §5): the plan
// stream parsing (never printing or keeping the plan, which holds the mock
// admin password), the pinned hcl2json, --check, and that the committed
// planned files are fresh in shape. terraform and hcl2json are faked here; CI
// runs them for real (npm run labs-topology -- --check).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { diagnostics, planFromTestStream, refsFromHcl, scrubChanges, PLAN_OUTPUTS } from "../lib/topology-stream.mjs";
import { hclResources } from "../../infra/ci/lab-scope.mjs";
import { HCL2JSON_SHA256, HCL2JSON_VERSION, hcl2jsonAsset, hcl2jsonMatchesPin, pinnedHcl2json } from "../lib/hcl2json.mjs";
import { runLabsTopology } from "../labs-topology.mjs";
import { labFolders } from "../lib/labs.mjs";

const MOCK_PASSWORD = "Mock-Passw0rd-labs-tf-not-real";

/** A terraform test -verbose -json stream with one test_plan message, as Terraform 1.14.6 prints it. */
export function fakeStream({ plan = true, diag = [] } = {}) {
  const lines = [
    { "@level": "info", "@message": "Terraform 1.14.6", type: "version", terraform: "1.14.6" },
    { "@level": "info", "@message": "Found 1 file and 1 run block", type: "test_abstract", test_abstract: {} },
  ];
  for (const d of diag) lines.push({ "@level": "error", "@message": `Error: ${d.summary}`, type: "diagnostic", diagnostic: { severity: "error", summary: d.summary, detail: d.detail ?? "" } });
  if (plan) {
    lines.push({
      "@level": "info",
      "@message": "-verbose flag enabled, printing plan",
      type: "test_plan",
      test_plan: {
        plan_format_version: "1.2",
        resource_changes: [
          {
            address: "azurerm_linux_virtual_machine.app",
            mode: "managed",
            type: "azurerm_linux_virtual_machine",
            name: "app",
            provider_name: "registry.terraform.io/hashicorp/azurerm",
            change: {
              actions: ["create"],
              before: null,
              after: { name: "vm-app", size: "Standard_B1s", admin_password: MOCK_PASSWORD, custom_data: "I2Nsb3VkLWNvbmZpZw==", admin_ssh_key: [{ public_key: "ssh-ed25519 AAAA", username: "azureuser" }], tags: { lab: "x" } },
              after_unknown: { id: true, network_interface_ids: [true] },
              before_sensitive: false,
              after_sensitive: { admin_password: true, custom_data: true },
            },
          },
          {
            address: "data.azurerm_client_config.current",
            mode: "data",
            type: "azurerm_client_config",
            name: "current",
            change: { actions: ["read"], after: {}, after_unknown: {} },
          },
          {
            address: 'azurerm_subnet.spoke["a"]',
            mode: "managed",
            type: "azurerm_subnet",
            name: "spoke",
            index: "a",
            change: { actions: ["create"], after: { name: "snet-a", address_prefixes: ["10.71.192.0/24"], shared_access_key: "abc" }, after_unknown: { id: true }, after_sensitive: {} },
          },
        ],
        output_changes: {
          peer_vnet_id: { actions: ["create"], after_unknown: true },
          private_ips: { actions: ["create"], after: { "vm-app": "10.71.192.4" }, after_unknown: {} },
          connect: { actions: ["create"], after: ["ssh azureuser@10.71.192.4"], after_unknown: [false] },
        },
        relevant_attributes: [],
        provider_format_version: "1.0",
        provider_schemas: { "registry.terraform.io/hashicorp/azurerm": { resource_schemas: {} } },
      },
    });
  }
  lines.push({ "@level": "info", "@message": "Success! 1 passed, 0 failed.", type: "test_summary", test_summary: { status: "pass" } });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("planFromTestStream takes resource_changes and output_changes from the test_plan message", () => {
  const { changes, outputs } = planFromTestStream(fakeStream());
  assert.deepEqual(
    changes.map((c) => c.address),
    ["azurerm_linux_virtual_machine.app", 'azurerm_subnet.spoke["a"]'],
    "managed resources only, in order",
  );
  assert.equal(changes[1].index, "a");
  assert.deepEqual(changes[0].after_unknown, { id: true, network_interface_ids: [true] });
  // Outputs: only the ones the builder reads, unknown as null.
  assert.deepEqual(Object.keys(outputs).sort(), [...PLAN_OUTPUTS].sort());
  assert.equal(outputs.peer_vnet_id, null);
});

test("planFromTestStream fails without a test_plan message", () => {
  assert.throws(() => planFromTestStream(fakeStream({ plan: false })), /no test_plan message/);
  assert.throws(() => planFromTestStream("not json\n"), /no test_plan message/);
});

test("the changes it returns hold no sensitive, secret-named or secret-like value", () => {
  const { changes } = planFromTestStream(fakeStream());
  const text = JSON.stringify(changes);
  assert.doesNotMatch(text, /Mock-Passw0rd/);
  assert.doesNotMatch(text, /custom_data|admin_password|admin_ssh_key|shared_access_key/);
  assert.match(text, /Standard_B1s/);
  assert.match(text, /10\.71\.192\.0\/24/);
  // No provider schemas, before values or sensitivity maps travel on.
  assert.deepEqual(Object.keys(changes[0]).sort(), ["address", "after", "after_unknown", "index", "name", "type"]);
});

test("scrubChanges drops what after_sensitive marks, at any depth", () => {
  const [c] = scrubChanges([
    { address: "x.y", type: "x", name: "y", change: { after: { a: { b: "keep", c: "drop" }, list: [{ s: "drop" }, { s: "keep" }] }, after_unknown: {}, after_sensitive: { a: { c: true }, list: [{ s: true }, {}] } } },
  ]);
  assert.deepEqual(c.after, { a: { b: "keep" }, list: [{}, { s: "keep" }] });
});

// Lab 28's web tier calls the app tier at "http://ca-app": a container env value that is only a URL to a bare host
// name (another app of the environment) can hold no secret, and is what draws the planned web -> app edge. Every
// other `value` stays unread: a host with dots, credentials, a path or query, a plain word, a value outside `env`.
test("scrubChanges keeps a container env value that is a URL to a bare app name, and no other value", () => {
  const env = (value) => ({ template: [{ container: [{ name: "c", env: [{ name: "X", value }] }] }] });
  const kept = (after) => JSON.stringify(scrubChanges([{ address: "a.b", type: "azurerm_container_app", name: "b", change: { after, after_unknown: {}, after_sensitive: {} } }])[0].after);
  for (const v of ["http://ca-app", "https://ca-app/", "http://ca-app:8080"]) assert.match(kept(env(v)), new RegExp(v.replace(/[/.]/g, "\\$&")), v);
  for (const v of ["http://user:pw@ca-app", "https://example.org", "http://ca-app/x?sig=abc", "labadmin", "Server=tcp:x,1433;Password=p", "http://Mock-Passw0rd-labs-tf-not-real"]) assert.doesNotMatch(kept(env(v)), /"value"/, v);
  assert.doesNotMatch(kept({ value: "http://ca-app", tags: { value: "http://ca-app" } }), /"value"/, "only inside a container's env");
  assert.doesNotMatch(JSON.stringify(scrubChanges([{ address: "a.b", type: "azurerm_container_app", name: "b", change: { after: env("http://ca-app"), after_unknown: {}, after_sensitive: { template: [{ container: [{ env: [{ value: true }] }] }] } } }])[0].after), /"value"/, "never a sensitive one");
});

test("refsFromHcl gives each resource's references by top-level attribute, and the outputs' references", () => {
  // hcl2json's shape for: a NIC in a subnet, a VM using it, and an output naming a VNet.
  const hcl = {
    resource: {
      azurerm_network_interface: { app: [{ name: "nic-app", resource_group_name: "${azurerm_resource_group.lab.name}", ip_configuration: [{ name: "c", subnet_id: "${azurerm_subnet.app.id}" }] }] },
      azurerm_linux_virtual_machine: { app: [{ name: "vm-app", admin_password: "${var.admin_password}", network_interface_ids: ["${azurerm_network_interface.app.id}"] }] },
    },
    data: { azurerm_client_config: { current: [{}] } },
    output: { peer_vnet_id: [{ value: "${azurerm_virtual_network.hub.id}" }], note: [{ value: "plain" }] },
  };
  const refs = refsFromHcl(hcl, "az104-13-vnets", hclResources);
  assert.deepEqual(refs, {
    "azurerm_linux_virtual_machine.app": { network_interface_ids: ["azurerm_network_interface.app"] },
    "azurerm_network_interface.app": { ip_configuration: ["azurerm_subnet.app"], resource_group_name: ["azurerm_resource_group.lab"] },
    "output.peer_vnet_id": { value: ["azurerm_virtual_network.hub"] },
  });
});

test("diagnostics prints only the stream's diagnostic messages, with the mock secrets redacted", () => {
  const text = fakeStream({ plan: true, diag: [{ summary: "Invalid value", detail: `got ${MOCK_PASSWORD}` }] });
  const d = diagnostics(text);
  assert.equal(d.length, 1);
  assert.match(d[0], /^error: Invalid value/);
  assert.doesNotMatch(d.join("\n"), /Mock-Passw0rd|Standard_B1s|resource_changes/);
});

// ── The generator (terraform and hcl2json faked) ──────────────────────────

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};

/** A labs folder with these labs (id → version), each with one .tf file. */
function labsDir(labs) {
  const dir = tmp("labs-topo-");
  for (const [id, version] of Object.entries(labs)) {
    mkdirSync(join(dir, id, "terraform"), { recursive: true });
    writeFileSync(join(dir, id, "lab.yaml"), `id: ${id}\nversion: ${version}\n`);
    writeFileSync(join(dir, id, "terraform", "main.tf"), 'resource "azurerm_resource_group" "lab" {}\n');
  }
  mkdirSync(join(dir, "_template"));
  mkdirSync(join(dir, "setup"));
  return dir;
}

/** A fake terraform and hcl2json: init and test succeed (unless `fail`), hcl2json prints an empty document. */
function fakeRun({ fail = false, diag = [] } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "terraform" && args[0] === "version") return { status: 0, stdout: "Terraform v1.14.6", stderr: "" };
    if (cmd === "terraform" && args[0] === "init") return { status: 0, stdout: "", stderr: "" };
    if (cmd === "terraform" && args[0] === "test") return { status: fail ? 1 : 0, stdout: fakeStream({ plan: true, diag }), stderr: fail ? `stderr with ${MOCK_PASSWORD}` : "" };
    if (cmd === "hcl2json") return { status: 0, stdout: JSON.stringify({ resource: {} }), stderr: "" };
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

/** A tiny stand-in for plannedGraph: one generic node per change. */
const fakeBuild = (input) => ({
  schema: 1,
  labId: input.labId,
  version: input.version,
  source: "planned",
  at: null,
  nodes: input.changes.map((c) => ({ id: `tf:${c.address}`, key: c.address, kind: "generic", label: String(c.after.name ?? c.name), props: {} })),
  edges: [],
});
const fakeDeny = (g) => (JSON.stringify(g).includes(MOCK_PASSWORD) ? ["the mock admin password appears in the graph"] : []);
const opts = (extra) => ({ hcl2json: "hcl2json", bicep: "bicep-not-needed", build: fakeBuild, deny: fakeDeny, ...extra });

test("on a failed run only diagnostic messages are printed", async () => {
  const labs = labsDir({ "az104-13-vnets": 3 });
  const out = tmp("planned-");
  const lines = [];
  const { run } = fakeRun({ fail: true, diag: [{ summary: "Invalid value for variable", detail: `the value ${MOCK_PASSWORD} is not allowed` }] });
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: (l) => lines.push(String(l)) }));
  assert.deepEqual(r.failures.map((f) => f.lab), ["az104-13-vnets"]);
  const text = lines.join("\n") + r.failures.map((f) => f.message).join("\n");
  assert.match(text, /Invalid value for variable/);
  assert.doesNotMatch(text, /Mock-Passw0rd|resource_changes|test_plan|Standard_B1s|stderr with/);
  assert.deepEqual(readdirSync(out), [], "nothing is written for a failed lab");
});

test("without terraform the generator fails with a reason; it never skips", async () => {
  const labs = labsDir({ "az104-13-vnets": 3 });
  const run = (cmd) => (cmd === "terraform" ? { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn terraform ENOENT"), { code: "ENOENT" }) } : { status: 0, stdout: "{}", stderr: "" });
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: tmp("planned-"), run, log: () => {} }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].message, /terraform is not installed/);
});

test("it writes one planned file per lab (LF, one-space JSON), removes orphans, and two runs give identical files", async () => {
  const labs = labsDir({ "az104-13-vnets": 3, "az700-35-forced-tunnel-fix": 2 });
  const out = tmp("planned-");
  writeFileSync(join(out, "az104-99-gone.json"), "{}\n");
  const { run, calls } = fakeRun();
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {} }));
  assert.deepEqual(r.failures, []);
  assert.deepEqual(readdirSync(out).sort(), ["az104-13-vnets.json", "az700-35-forced-tunnel-fix.json"]);
  const first = readFileSync(join(out, "az104-13-vnets.json"), "utf8");
  assert.ok(first.endsWith("}\n") && !first.includes("\r"));
  const g = JSON.parse(first);
  assert.equal(g.labId, "az104-13-vnets");
  assert.equal(g.version, 3);
  assert.equal(first, JSON.stringify(g, null, 1) + "\n");
  assert.ok(calls.some((c) => c.startsWith("terraform test -verbose -json -no-color")));
  await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {} }));
  assert.equal(readFileSync(join(out, "az104-13-vnets.json"), "utf8"), first);
});

test("--check exits 1 naming a changed lab, a missing file and an orphan file", async () => {
  const labs = labsDir({ "az104-13-vnets": 3, "az104-14-peering-udr": 1, "az104-15-dns": 1 });
  const out = tmp("planned-");
  const { run } = fakeRun();
  await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {} }));
  // 14 changed, 15 missing, an orphan.
  const g14 = JSON.parse(readFileSync(join(out, "az104-14-peering-udr.json"), "utf8"));
  g14.version = 0;
  writeFileSync(join(out, "az104-14-peering-udr.json"), JSON.stringify(g14, null, 1) + "\n");
  rmSync(join(out, "az104-15-dns.json"));
  writeFileSync(join(out, "az104-99-gone.json"), "{}\n");
  const before = readdirSync(out).sort().map((f) => readFileSync(join(out, f), "utf8"));
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {}, check: true }));
  assert.deepEqual(r.failures.map((f) => f.lab).sort(), ["az104-14-peering-udr", "az104-15-dns", "az104-99-gone"]);
  assert.match(r.failures.find((f) => f.lab === "az104-14-peering-udr").message, /changed/);
  assert.match(r.failures.find((f) => f.lab === "az104-15-dns").message, /missing/);
  assert.match(r.failures.find((f) => f.lab === "az104-99-gone").message, /no lab folder/);
  assert.deepEqual(readdirSync(out).sort().map((f) => readFileSync(join(out, f), "utf8")), before, "--check writes nothing");
});

test("files are compared parsed, so CRLF never counts", async () => {
  const labs = labsDir({ "az104-13-vnets": 3 });
  const out = tmp("planned-");
  const { run } = fakeRun();
  await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {} }));
  const f = join(out, "az104-13-vnets.json");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {}, check: true }));
  assert.deepEqual(r.failures, []);
});

test("a graph that fails the deny check is never written", async () => {
  const labs = labsDir({ "az104-13-vnets": 3 });
  const out = tmp("planned-");
  const { run } = fakeRun();
  const leaky = (input) => ({ ...fakeBuild(input), notes: [MOCK_PASSWORD] });
  const r = await runLabsTopology(opts({ labsDir: labs, outDir: out, run, log: () => {}, build: leaky }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].message, /deny check/);
  assert.doesNotMatch(r.failures[0].message, /Mock-Passw0rd/);
  assert.deepEqual(readdirSync(out), []);
});

// ── hcl2json, pinned ──────────────────────────────────────────────────────

const sha = (b) => createHash("sha256").update(b).digest("hex");

test("pinnedHcl2json verifies the checksum before use", async () => {
  const good = Buffer.from("the real hcl2json");
  const pins = { hcl2json_linux_amd64: sha(good) };
  const cache = tmp("hcl2json-");
  const fetchOf = (bytes) => async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes });
  const logs = [];
  // A download that does not match is refused and leaves nothing behind.
  assert.equal(await pinnedHcl2json({ cacheDir: cache, asset: "hcl2json_linux_amd64", sha256: pins, fetch: fetchOf(Buffer.from("tampered")), log: (l) => logs.push(l) }), null);
  assert.deepEqual(readdirSync(cache), []);
  assert.match(logs.join("\n"), /checksum/);
  // The pinned bytes are kept and returned.
  const p = await pinnedHcl2json({ cacheDir: cache, asset: "hcl2json_linux_amd64", sha256: pins, fetch: fetchOf(good), log: () => {} });
  assert.equal(p, join(cache, "hcl2json_linux_amd64"));
  assert.equal(hcl2jsonMatchesPin(p, "hcl2json_linux_amd64", pins), true);
  // A cached file changed afterwards is checked again before use and replaced.
  writeFileSync(p, "changed on disk");
  assert.equal(hcl2jsonMatchesPin(p, "hcl2json_linux_amd64", pins), false);
  assert.equal(await pinnedHcl2json({ cacheDir: cache, asset: "hcl2json_linux_amd64", sha256: pins, fetch: fetchOf(good), log: () => {} }), p);
  assert.equal(readFileSync(p, "utf8"), "the real hcl2json");
});

test("the hcl2json pin: v0.6.9, an asset per machine, and CI installs the same version and checksum", () => {
  assert.equal(HCL2JSON_VERSION, "0.6.9");
  assert.equal(hcl2jsonAsset("linux", "x64"), "hcl2json_linux_amd64");
  assert.equal(hcl2jsonAsset("win32", "x64"), "hcl2json_windows_amd64.exe");
  assert.equal(hcl2jsonAsset("darwin", "arm64"), "hcl2json_darwin_arm64");
  assert.equal(hcl2jsonAsset("sunos", "x64"), null);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(ci.includes(`releases/download/v${HCL2JSON_VERSION}/hcl2json_linux_amd64`));
  assert.ok(ci.includes(`${HCL2JSON_SHA256.hcl2json_linux_amd64}  hcl2json_linux_amd64`));
});

test("CI's labs job runs labs-topology --check after labs-tf, with the pinned tools", () => {
  const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const steps = ci.jobs.labs.steps;
  const tf = steps.findIndex((s) => s.name === "labs-tf");
  const topo = steps.findIndex((s) => typeof s.run === "string" && s.run.includes("npm run labs-topology -- --check"));
  assert.ok(tf >= 0 && topo > tf, "labs-topology --check runs after labs-tf");
  assert.ok(steps[topo].env.TF_PLUGIN_CACHE_DIR && steps[topo].env.BICEP && steps[topo].env.HCL2JSON);
});

// ── The committed planned files ───────────────────────────────────────────

const PLANNED = fileURLToPath(new URL("../../shared/topology/planned/", import.meta.url));
const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));

test("the committed planned files: one per lab folder, each its lab's id and lab.yaml version, no mock secret", () => {
  const ids = labFolders(LABS);
  assert.ok(existsSync(PLANNED), "shared/topology/planned exists");
  assert.deepEqual(readdirSync(PLANNED).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(), ids);
  for (const id of ids) {
    const text = readFileSync(join(PLANNED, `${id}.json`), "utf8");
    assert.doesNotMatch(text, /Mock-Passw0rd|AAAAC3NzaC1lZDI1NTE5|admin_password|custom_data/, id);
    const g = JSON.parse(text);
    assert.equal(g.labId, id);
    assert.equal(g.source, "planned");
    assert.equal(g.version, parse(readFileSync(join(LABS, id, "lab.yaml"), "utf8")).version, `${id}: version follows lab.yaml`);
  }
});

test(".gitattributes keeps the planned files LF", () => {
  assert.match(readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8"), /^shared\/topology\/planned\/\*\.json text eol=lf$/m);
});
