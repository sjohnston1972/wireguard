// lab-tf.test.mjs
//
// Plain English: "npm run labs-tf" (scripts/labs-tf.mjs) and CI's labs job,
// the Terraform half of a lab's static checks (labs spec §11.1): per lab and
// the template, terraform fmt -check, init -backend=false and validate, and
// the HCL scope check (hcl2json into infra/ci/lab-scope.mjs --hcl). Unlike
// labs-check, a lab with no terraform/ folder FAILS here: it cannot be
// released. The commands are faked; CI runs them for real.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { labFolders } from "../lib/labs.mjs";
import { BICEP_SHA256, BICEP_VERSION, bicepAsset, bicepMatchesPin, pinnedBicep } from "../lib/bicep.mjs";
import { labsTfTargets, runLabsTf } from "../labs-tf.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const CI = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));

/** A labs folder with the real template, one lab with Terraform and one without. */
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function labsDir() {
  const dir = mkdtempSync(join(tmpdir(), "labs-tf-"));
  made.push(dir);
  cpSync(join(LABS, "_template"), join(dir, "_template"), { recursive: true });
  mkdirSync(join(dir, "setup"));
  for (const id of ["az104-05-storage", "az104-06-blob-security"]) {
    cpSync(join(LABS, id), join(dir, id), { recursive: true });
    // The real labs now carry Terraform: drop it so 05 has none and 06 has exactly the template.
    rmSync(join(dir, id, "terraform"), { recursive: true, force: true });
  }
  mkdirSync(join(dir, "az104-06-blob-security", "terraform"));
  for (const f of ["versions.tf", "variables.tf", "outputs.tf", "main.tf"]) cpSync(join(LABS, "_template", f), join(dir, "az104-06-blob-security", "terraform", f));
  return dir;
}

/** A fake command runner: records [cmd, args, cwd]; hcl2json answers with `hcl` (or is missing); bicep build writes `template` to its --outfile. */
function fakeRun({ hcl = { resource: { azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] } } }, missing = [], fail = {}, template = BICEP_BUILT } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, args.join(" "), opts.cwd ?? ""]);
    if (missing.includes(cmd)) return { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }), stdout: "", stderr: "" };
    const key = `${cmd} ${args[0]}`;
    if (fail[key]) return { status: 1, stdout: "", stderr: fail[key] };
    if (cmd === "hcl2json") return { status: 0, stdout: JSON.stringify(typeof hcl === "function" ? hcl(args) : hcl), stderr: "" };
    if (cmd === "bicep" && args[0] === "build") writeFileSync(join(opts.cwd, args[3]), JSON.stringify(template));
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}
const quiet = () => {};
const BICEP_BUILT = JSON.parse(readFileSync(new URL("./fixtures/labs/bicep/storage-vnet.json", import.meta.url), "utf8"));
const BICEP_LAB = "az104-06-blob-security";
/** labsDir() with lab 6 as a Bicep lab: main.bicep and its module vnet.bicep beside the .tf files. */
function bicepLabsDir() {
  const dir = labsDir();
  for (const f of ["storage-vnet.bicep", "vnet.bicep"]) cpSync(fileURLToPath(new URL(`./fixtures/labs/bicep/${f}`, import.meta.url)), join(dir, BICEP_LAB, "terraform", f === "storage-vnet.bicep" ? "main.bicep" : f));
  return dir;
}
const slash = (p) => p.replace(/\\/g, "/");

test("labs-tf deletes its scratch copies when it finishes, even when a check fails", () => {
  const copies = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("labs-tf-copy-")));
  const before = copies();
  runLabsTf({ labsDir: labsDir(), run: fakeRun().run, log: quiet });
  runLabsTf({ labsDir: labsDir(), run: fakeRun({ fail: { "terraform fmt": "bad format" } }).run, log: quiet });
  assert.deepEqual([...copies()].filter((n) => !before.has(n)), []);
});

test("labs-tf lists each lab and the template", () => {
  const targets = labsTfTargets(LABS);
  assert.equal(targets[0].folder, "_template");
  assert.equal(targets[0].problem, null);
  assert.match(targets[0].labId, /^az104-\d{2}-template$/);
  assert.deepEqual(targets.slice(1).map((t) => t.folder), labFolders(LABS));
  for (const t of targets.slice(1)) {
    assert.equal(t.labId, t.folder);
    assert.ok(t.dir.replace(/\\/g, "/").endsWith(`${t.folder}/terraform`));
  }
});

test("labs-tf fails a lab with no terraform/ folder (labs-check only notes it)", () => {
  const dir = labsDir();
  const t = labsTfTargets(dir);
  assert.match(t.find((x) => x.folder === "az104-05-storage").problem, /no terraform\/ folder/);
  assert.equal(t.find((x) => x.folder === "az104-06-blob-security").problem, null);
  const { run } = fakeRun();
  const { failures } = runLabsTf({ labsDir: dir, run, log: quiet });
  assert.deepEqual(failures.map((f) => f.folder), ["az104-05-storage"]);
});

test("labs-tf runs fmt in place, init -backend=false and validate on a copy, then the HCL scope check", () => {
  const dir = labsDir();
  const { calls, run } = fakeRun();
  runLabsTf({ labsDir: dir, run, log: quiet, only: ["_template", "az104-06-blob-security"] });
  for (const folder of ["_template", "az104-06-blob-security"]) {
    const mine = calls.filter((c) => c[2].replace(/\\/g, "/").includes(`/${folder}`) || (c[0] === "hcl2json" && c[1].includes(folder)));
    const seq = mine.map((c) => `${c[0]} ${c[1].split(" ")[0]}`);
    // terraform test is the offline mock plan (labs batch 3 plan, C0.2), after validate.
    assert.deepEqual(seq, ["terraform fmt", "terraform init", "terraform validate", "terraform test", "hcl2json " + mine.find((c) => c[0] === "hcl2json")[1].split(" ")[0]], folder);
    assert.match(mine[0][1], /^fmt -check -diff -recursive$/);
    assert.match(mine[1][1], /^init -backend=false -input=false -no-color$/);
    // init writes .terraform and a lock file: never inside the repo.
    assert.ok(!mine[1][2].replace(/\\/g, "/").startsWith(dir.replace(/\\/g, "/")), `init ran in ${mine[1][2]}`);
  }
});

test("labs-tf fails a lab whose HCL breaks a scope rule, a fmt or a validate", () => {
  const dir = labsDir();
  const evil = { resource: { azurerm_resource_group: { other: [{ name: "rg-shared", location: "uksouth" }] } } };
  const scope = runLabsTf({ labsDir: dir, run: fakeRun({ hcl: evil }).run, log: quiet, only: ["az104-06-blob-security"] });
  assert.equal(scope.failures.length, 1);
  assert.match(scope.failures[0].message, /resource-group: azurerm_resource_group\.other/);
  const fmt = runLabsTf({ labsDir: dir, run: fakeRun({ fail: { "terraform fmt": "main.tf" } }).run, log: quiet, only: ["az104-06-blob-security"] });
  assert.match(fmt.failures[0].message, /fmt/);
  const validate = runLabsTf({ labsDir: dir, run: fakeRun({ fail: { "terraform validate": "Error: Reference to undeclared resource" } }).run, log: quiet, only: ["_template"] });
  assert.match(validate.failures[0].message, /validate/);
});

// Ruling 35: validate misses what only a plan finds (a variable's validation, a bad cidrsubnet,
// a provider's own checks on known values), so each lab is planned offline with mocked providers.
test("labs-tf plans each lab offline with mocked providers and names a lab whose plan fails", () => {
  const dir = labsDir();
  // The copy (with its test file) is deleted at the end: read the file when terraform test runs.
  const seen = {};
  const base = fakeRun();
  const run = (cmd, args, opts = {}) => {
    if (cmd === "terraform" && args[0] === "test") seen[slash(opts.cwd).split("/").pop()] = readFileSync(join(opts.cwd, "tests", "labs-mock.tftest.hcl"), "utf8");
    return base.run(cmd, args, opts);
  };
  const { failures } = runLabsTf({ labsDir: dir, run, log: quiet, only: ["_template", "az104-06-blob-security"] });
  assert.deepEqual(failures, []);
  const tests = base.calls.filter((c) => c[0] === "terraform" && c[1].startsWith("test"));
  assert.equal(tests.length, 2);
  for (const c of tests) {
    assert.equal(c[1], "test -no-color");
    assert.ok(!slash(c[2]).startsWith(slash(dir)), `terraform test ran in ${c[2]}, not the repo`);
  }
  const hcl = seen["az104-06-blob-security"];
  assert.ok(hcl, Object.keys(seen).join());
  // The providers the lab declares are mocked (lab 6 is the template: azurerm and azuread), with data sources
  // that give real-looking ids (azurerm checks a role definition's scope even in a mocked plan).
  assert.match(hcl, /^mock_provider "azurerm" \{/m);
  assert.match(hcl, /^mock_provider "azuread" \{\}/m);
  assert.doesNotMatch(hcl, /mock_provider "(random|time)"/, "a provider the lab does not install cannot be mocked (terraform test: unknown provider)");
  assert.match(hcl, /mock_data "azurerm_subscription" \{\s*defaults = \{\s*id\s*= "\/subscriptions\/[0-9a-f-]{36}"/);
  assert.match(hcl, /mock_data "azurerm_client_config" \{[\s\S]*object_id\s*= "[0-9a-f-]{36}"/);
  // One plan run with the contract variables: slot 31, uksouth and ukwest, a fake key, the lab's own names.
  assert.match(hcl, /run "plan" \{\s*command = plan\s*\}/);
  for (const v of [/lab_id\s*= "az104-06-blob-security"/, /resource_group_name\s*= "rg-lab-az104-06-blob-security"/, /region\s*= "uksouth"/, /secondary_region\s*= "ukwest"/, /address_space\s*= "10\.71\.192\.0\/18"/, /peered\s*= false/, /gateway_vnet_id\s*= ""/, /name_prefix\s*= "l06[a-z0-9]{5}"/, /ssh_public_key\s*= "ssh-ed25519 /, /upn_domain\s*= "contoso\.onmicrosoft\.com"/, /admin_password\s*= "/, /tags\s*= \{/]) assert.match(hcl, v);
  assert.match(seen._template, /lab_id\s*= "az104-00-template"/);
  // A lab whose mock plan fails is named, with Terraform's error.
  const bad = runLabsTf({ labsDir: dir, run: fakeRun({ fail: { "terraform test": "Error: Invalid value for variable secondary_region" } }).run, log: quiet, only: ["az104-06-blob-security"] });
  assert.deepEqual(bad.failures.map((f) => f.folder), ["az104-06-blob-security"]);
  assert.match(bad.failures[0].message, /mock plan \(terraform test\).*secondary_region/);
  // No plan without a valid configuration.
  const invalid = fakeRun({ fail: { "terraform validate": "Error: bad" } });
  runLabsTf({ labsDir: dir, run: invalid.run, log: quiet, only: ["az104-06-blob-security"] });
  assert.equal(invalid.calls.filter((c) => c[0] === "terraform" && c[1].startsWith("test")).length, 0);
});

test("without hcl2json the HCL check is skipped with a note locally, and fails when CI requires it", () => {
  const dir = labsDir();
  const lines = [];
  const local = runLabsTf({ labsDir: dir, run: fakeRun({ missing: ["hcl2json"] }).run, log: (l) => lines.push(l), only: ["_template"] });
  assert.deepEqual(local.failures, []);
  assert.match(lines.join("\n"), /hcl2json.*not installed.*skipped/i);
  const ci = runLabsTf({ labsDir: dir, run: fakeRun({ missing: ["hcl2json"] }).run, log: quiet, only: ["_template"], requireHcl2json: true });
  assert.equal(ci.failures.length, 1);
  assert.equal(runLabsTf({ labsDir: dir, run: fakeRun({ missing: ["terraform"] }).run, log: quiet, only: ["_template"] }).failures.length, 1, "no terraform is a failure, never a pass");
});

test("npm run labs-tf and labs-setup exist, and CI's labs job runs labs-tf through npm with hcl2json required", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["labs-tf"], "node scripts/labs-tf.mjs");
  assert.equal(pkg.scripts["labs-setup"], "node scripts/labs-setup.mjs");
  const step = CI.jobs.labs.steps.find((s) => s.name === "labs-tf");
  assert.ok(step, "ci.yml labs job has a labs-tf step");
  assert.match(step.run, /^\s*npm run labs-tf\s*$/m);
  assert.equal(String(step.env?.LABS_TF_REQUIRE_HCL2JSON), "1");
});

test("ci labs job pins hcl2json by checksum", () => {
  const job = CI.jobs.labs;
  assert.ok(job, "ci.yml has a labs job");
  const steps = job.steps;
  const checkout = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0);
  const tf = steps.find((s) => String(s.uses ?? "").startsWith("hashicorp/setup-terraform@"));
  assert.equal(tf.with.terraform_version, "1.14.6");
  const all = steps.map((s) => s.run ?? "").join("\n");
  assert.match(all, /https:\/\/github\.com\/tmccombs\/hcl2json\/releases\/download\/v\d+\.\d+\.\d+\/hcl2json_linux_amd64/);
  assert.match(all, /[0-9a-f]{64} {2}\S*hcl2json/);
  assert.match(all, /sha256sum -c/);
  assert.ok(all.indexOf("sha256sum -c") < all.indexOf("chmod +x"), "checked before it is made runnable");
  assert.match(all, /npm run labs-check -- --base origin\/main/);
  assert.match(all, /npm run labs-tf/);
  assert.equal(JSON.stringify(steps.find((s) => s.name === "labs-tf")?.env ?? {}).includes("LABS_TF_REQUIRE_HCL2JSON"), true);
  // Pinned actions, no secrets.
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, /@[0-9a-f]{40}/);
  assert.ok(!JSON.stringify(job).includes("secrets."));
});

// ── Bicep (batch 2: lab 12) ──────────────────────────────────────────────

test("labs-tf builds .bicep into its copy before validate and checks each template", () => {
  const dir = bicepLabsDir();
  const { calls, run } = fakeRun();
  const { failures } = runLabsTf({ labsDir: dir, run, log: quiet, only: [BICEP_LAB] });
  assert.deepEqual(failures, []);
  const seq = calls.map((c) => `${c[0]} ${c[1].split(" ").slice(0, 2).join(" ")}`);
  assert.deepEqual(seq.slice(0, 5), ["terraform fmt -check", "bicep build main.bicep", "bicep build vnet.bicep", "terraform init -backend=false", "terraform validate -no-color"]);
  const builds = calls.filter((c) => c[0] === "bicep");
  for (const [, args, cwd] of builds) {
    assert.match(args, /^build (\S+)\.bicep --outfile \1\.json$/);
    // Into the throw-away copy, never the repo.
    assert.ok(!slash(cwd).startsWith(slash(dir)), `bicep ran in ${cwd}`);
    assert.equal(cwd, calls.find((c) => c[1].startsWith("init"))[2], "the copy terraform init reads");
  }
  // A template that reaches outside the lab fails the lab, naming the file and the rule.
  const graph = { $schema: BICEP_BUILT.$schema, contentVersion: "1.0.0.0", languageVersion: "2.0", extensions: { graph: { name: "MicrosoftGraph", version: "1.0.0" } }, resources: { g: { type: "Microsoft.Graph/groups@v1.0", extension: "graph", name: "g" } } };
  const evil = runLabsTf({ labsDir: dir, run: fakeRun({ template: graph }).run, log: quiet, only: [BICEP_LAB] });
  // (The fake builds the same template from both files: each is reported.)
  assert.deepEqual(evil.failures.map((f) => f.message.match(/^template (\S+): (\S+): /)?.slice(1)), [["main.json", "role"], ["vnet.json", "role"]]);
  // A build that fails is a failure, and nothing after it runs for that lab.
  const broken = fakeRun({ fail: { "bicep build": "Error BCP018: Expected the \"}\" character at this location." } });
  const b = runLabsTf({ labsDir: dir, run: broken.run, log: quiet, only: [BICEP_LAB] });
  assert.match(b.failures[0].message, /bicep build main\.bicep: .*BCP018/);
  assert.ok(!broken.calls.some((c) => c[1].startsWith("init")), "no init after a failed build");
});

test("without bicep a Bicep lab is skipped with a note locally and fails when CI requires it", () => {
  const dir = bicepLabsDir();
  const lines = [];
  const local = fakeRun({ missing: ["bicep"] });
  const r = runLabsTf({ labsDir: dir, run: local.run, log: (l) => lines.push(l), only: ["_template", BICEP_LAB] });
  assert.deepEqual(r.failures, []);
  assert.match(lines.join("\n"), new RegExp(`${BICEP_LAB}.*bicep.*not installed.*skipped`, "i"));
  // The Bicep lab's init and validate are skipped (file() of the missing JSON would fail); the template's still run.
  const inits = local.calls.filter((c) => c[1].startsWith("init")).map((c) => slash(c[2]));
  assert.equal(inits.length, 1);
  assert.ok(inits[0].endsWith("/_template"));
  // fmt and the HCL scope check still run for it.
  assert.ok(local.calls.some((c) => c[0] === "terraform" && c[1].startsWith("fmt") && slash(c[2]).endsWith(`${BICEP_LAB}/terraform`)));
  const ci = runLabsTf({ labsDir: dir, run: fakeRun({ missing: ["bicep"] }).run, log: quiet, only: ["_template", BICEP_LAB], requireBicep: true });
  assert.deepEqual(ci.failures.map((f) => f.folder), [BICEP_LAB]);
  assert.match(ci.failures[0].message, /bicep is not installed/);
  // A lab with no .bicep files never needs it.
  assert.deepEqual(runLabsTf({ labsDir: labsDir(), run: fakeRun({ missing: ["bicep"] }).run, log: quiet, only: [BICEP_LAB], requireBicep: true }).failures, []);
});

test("ci labs job installs bicep pinned by checksum and requires it", () => {
  const steps = CI.jobs.labs.steps;
  const install = steps.find((s) => s.name === "install bicep");
  assert.ok(install, "ci.yml labs job has an install bicep step");
  const run = install.run;
  assert.ok(run.includes(`https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/bicep-linux-x64`), "the pinned release, from github.com/Azure/bicep");
  assert.ok(run.includes(`${BICEP_SHA256["bicep-linux-x64"]}  `), "the pinned checksum");
  assert.ok(run.indexOf("sha256sum -c") >= 0 && run.indexOf("sha256sum -c") < run.indexOf("chmod +x"), "checked before it is made runnable");
  assert.ok(steps.indexOf(install) < steps.findIndex((s) => s.name === "labs-tf"));
  const tf = steps.find((s) => s.name === "labs-tf");
  assert.equal(String(tf.env.LABS_TF_REQUIRE_BICEP), "1");
  assert.match(String(tf.env.BICEP), /bicep$/, "labs-tf is pointed at the installed binary (and checks its checksum again)");
});

test("a downloaded Bicep is used only when its sha256 matches the pin", async () => {
  assert.equal(bicepAsset("linux", "x64"), "bicep-linux-x64");
  assert.equal(bicepAsset("win32", "x64"), "bicep-win-x64.exe");
  assert.equal(bicepAsset("darwin", "arm64"), "bicep-osx-arm64");
  assert.equal(bicepAsset("aix", "ppc64"), null);
  // The pins are the official release's SHA-256 digests, one per asset.
  assert.match(BICEP_VERSION, /^\d+\.\d+\.\d+$/);
  for (const [asset, sha] of Object.entries(BICEP_SHA256)) assert.match(sha, /^[0-9a-f]{64}$/, asset);
  const bytes = Buffer.from("pretend bicep binary");
  const good = createHash("sha256").update(bytes).digest("hex");
  const asset = "bicep-linux-x64";
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return new Response(bytes);
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "bicep-"));
  const path = await pinnedBicep({ cacheDir, asset, sha256: { [asset]: good }, fetch, log: quiet });
  assert.equal(path, join(cacheDir, asset));
  assert.deepEqual(urls, [`https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/${asset}`]);
  assert.ok(bicepMatchesPin(path, asset, { [asset]: good }));
  // Cached: verified again, not downloaded again.
  assert.equal(await pinnedBicep({ cacheDir, asset, sha256: { [asset]: good }, fetch, log: quiet }), path);
  assert.equal(urls.length, 1);
  // Tampered with in the cache: downloaded afresh.
  writeFileSync(path, "tampered");
  assert.equal(await pinnedBicep({ cacheDir, asset, sha256: { [asset]: good }, fetch, log: quiet }), path);
  assert.equal(urls.length, 2);
  assert.ok(bicepMatchesPin(path, asset, { [asset]: good }));
  // A download that does not match the pin is thrown away and never returned.
  const other = mkdtempSync(join(tmpdir(), "bicep-"));
  const lines = [];
  assert.equal(await pinnedBicep({ cacheDir: other, asset, sha256: { [asset]: "0".repeat(64) }, fetch, log: (l) => lines.push(l) }), null);
  assert.deepEqual(readdirSync(other), []);
  assert.match(lines.join("\n"), /checksum/i);
  // No network, or no asset for this machine: null, never a throw.
  assert.equal(await pinnedBicep({ cacheDir: other, asset, sha256: { [asset]: good }, fetch: async () => { throw new Error("offline"); }, log: quiet }), null);
  assert.equal(await pinnedBicep({ cacheDir: other, asset: null, fetch, log: quiet }), null);
  assert.equal(bicepMatchesPin(join(other, "missing"), asset, { [asset]: good }), false);
});
