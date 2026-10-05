// lab-tf.test.mjs
//
// Plain English: "npm run labs-tf" (scripts/labs-tf.mjs) and CI's labs job,
// the Terraform half of a lab's static checks (labs spec §11.1): per lab and
// the template, terraform fmt -check, init -backend=false and validate, and
// the HCL scope check (hcl2json into infra/ci/lab-scope.mjs --hcl). Unlike
// labs-check, a lab with no terraform/ folder FAILS here: it cannot be
// released. The commands are faked; CI runs them for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { labFolders } from "../lib/labs.mjs";
import { labsTfTargets, runLabsTf } from "../labs-tf.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const CI = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));

/** A labs folder with the real template, one lab with Terraform and one without. */
function labsDir() {
  const dir = mkdtempSync(join(tmpdir(), "labs-tf-"));
  cpSync(join(LABS, "_template"), join(dir, "_template"), { recursive: true });
  mkdirSync(join(dir, "setup"));
  for (const id of ["az104-05-storage", "az104-06-blob-security"]) cpSync(join(LABS, id), join(dir, id), { recursive: true });
  mkdirSync(join(dir, "az104-06-blob-security", "terraform"));
  for (const f of ["versions.tf", "variables.tf", "outputs.tf", "main.tf"]) cpSync(join(LABS, "_template", f), join(dir, "az104-06-blob-security", "terraform", f));
  return dir;
}

/** A fake command runner: records [cmd, args, cwd]; hcl2json answers with `hcl` (or is missing). */
function fakeRun({ hcl = { resource: { azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] } } }, missing = [], fail = {} } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, args.join(" "), opts.cwd ?? ""]);
    if (missing.includes(cmd)) return { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }), stdout: "", stderr: "" };
    const key = `${cmd} ${args[0]}`;
    if (fail[key]) return { status: 1, stdout: "", stderr: fail[key] };
    if (cmd === "hcl2json") return { status: 0, stdout: JSON.stringify(typeof hcl === "function" ? hcl(args) : hcl), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}
const quiet = () => {};

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
    assert.deepEqual(seq, ["terraform fmt", "terraform init", "terraform validate", "hcl2json " + mine.find((c) => c[0] === "hcl2json")[1].split(" ")[0]], folder);
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
  assert.match(all, /LABS_TF_REQUIRE_HCL2JSON=1 node scripts\/labs-tf\.mjs|node scripts\/labs-tf\.mjs/);
  assert.equal(JSON.stringify(job.env ?? {}).includes("LABS_TF_REQUIRE_HCL2JSON") || all.includes("LABS_TF_REQUIRE_HCL2JSON=1"), true);
  // Pinned actions, no secrets.
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, /@[0-9a-f]{40}/);
  assert.ok(!JSON.stringify(job).includes("secrets."));
});
