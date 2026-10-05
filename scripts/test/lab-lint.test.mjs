// lab-lint.test.mjs
//
// Plain English: the checks lab.yml runs on a lab's Terraform text before
// `terraform init` (infra/ci/lab-lint.mjs): init downloads the providers the
// files name, and plan (and destroy) already runs data sources with the
// pipeline's keys, so a disallowed provider must be stopped before either.
// Providers are matched on their full source address, never on the last part.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintTfText } from "../lib/labs.mjs";
import { fileProblems, lintDir } from "../../infra/ci/lab-lint.mjs";
import { labFolders } from "../lib/labs.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../infra/ci/lab-lint.mjs", import.meta.url));
const VERSIONS = (providers) => `terraform {\n  required_providers {\n${providers}\n  }\n}\n`;
const AZURERM = '    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 4.0"\n    }';
const rules = (files) => [...new Set(lintTfText(files).map((p) => p.rule))].sort();

test("every lab and the template pass, folder and all", () => {
  for (const folder of labFolders(LABS)) assert.deepEqual(lintDir(join(LABS, folder, "terraform")), [], folder);
  assert.deepEqual(lintDir(join(LABS, "_template")), [], "_template");
});

test("azurerm, azuread, random and time are allowed, by full source address", () => {
  const ok = {
    "versions.tf": VERSIONS(`${AZURERM}\n    azuread = { source = "registry.terraform.io/hashicorp/azuread" }\n    random = { source = "hashicorp/random" }\n    time = { source = "HashiCorp/time" }`),
    "main.tf": 'resource "azurerm_resource_group" "lab" {}\nresource "azuread_group" "g" {}\nresource "random_string" "s" {}\nresource "time_sleep" "t" {}\n',
  };
  assert.deepEqual(lintTfText(ok), []);
});

test("a look-alike provider is refused: the source's last part is not enough", () => {
  for (const source of ["registry.example.com/hashicorp/azurerm", "evilcorp/azurerm", "registry.terraform.io/evilcorp/azurerm", "hashicorp/azurerm-extra"]) {
    const files = { "versions.tf": VERSIONS(`    azurerm = { source = "${source}" }`), "main.tf": 'resource "azurerm_resource_group" "lab" {}\n' };
    assert.ok(lintTfText(files).some((p) => p.rule === "provider" && p.file === "versions.tf"), source);
  }
});

test("azapi, external, http, null, local and the builtin terraform provider are refused, quoted or bare labels", () => {
  const cases = [
    ['resource "azapi_resource" "x" {}\n', "azapi"],
    ['data "external" "x" {\n  program = ["sh", "-c", "env"]\n}\n', "external"],
    ['data "http" "x" {\n  url = "https://example.com"\n}\n', "http"],
    ['resource "null_resource" "x" {}\n', "null"],
    ["resource null_resource x {}\n", "null (bare labels)"],
    ['resource "local_file" "x" {}\n', "local"],
    ['ephemeral "random_password" "x" {}\ndata "local_file" "y" {}\n', "local data"],
    ['resource "terraform_data" "x" {}\n', "terraform_data"],
    ['data "terraform_remote_state" "wg" {\n  backend = "s3"\n}\n', "terraform_remote_state"],
    ['check "c" {\n  data "http" "x" {\n    url = "https://example.com"\n  }\n}\n', "a data source scoped in a check block"],
    ['provider "external" {}\n', "provider block"],
  ];
  for (const [main, what] of cases) assert.deepEqual(rules({ "versions.tf": VERSIONS(AZURERM), "main.tf": main }), ["provider"], what);
  // Declared in required_providers is refused there too.
  for (const p of ["azapi = { source = \"azure/azapi\" }", 'null = { source = "hashicorp/null" }', 'external = "~> 2.0"']) {
    assert.ok(lintTfText({ "versions.tf": VERSIONS(`${AZURERM}\n    ${p}`) }).some((x) => x.rule === "provider"), p);
  }
});

test("provisioners, modules, import blocks and a backend other than the template's are refused", () => {
  const cases = [
    ['resource "azurerm_resource_group" "lab" {\n  provisioner "local-exec" {\n    command = "env"\n  }\n}\n', "provisioner"],
    ['module "net" {\n  source = "git::https://example.com/net.git"\n}\n', "module"],
    ['import {\n  to = azuread_user.x\n  id = "/users/1"\n}\n', "import"],
    ['terraform {\n  backend "http" {\n    address = "https://example.com/state"\n  }\n}\n', "backend"],
    ['terraform {\n  backend "s3" {\n    region = "auto"\n    endpoints {\n      s3 = "https://example.com"\n    }\n  }\n}\n', "backend"],
    ['terraform {\n  backend "s3" {\n    region = "auto"\n    bucket = "elsewhere"\n  }\n}\n', "backend"],
    ['terraform {\n  cloud {\n    organization = "x"\n  }\n}\n', "backend"],
  ];
  for (const [main, rule] of cases) assert.deepEqual(rules({ "main.tf": main }), [rule], main);
});

test("files Terraform reads but the lint cannot are refused", () => {
  assert.deepEqual(fileProblems(["main.tf", "versions.tf", "cloud-init.yaml.tftpl", "site.bicep", "site.json"]), []);
  for (const f of ["main.tf.json", "x.auto.tfvars", "terraform.tfvars.json", "terraform.rc", ".terraformrc"]) assert.equal(fileProblems([f])[0]?.rule, "file", f);
});

test("the command line: exit 1 with one line per problem before Terraform starts, 0 for a real lab, 2 for bad arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-lint-"));
  writeFileSync(join(dir, "main.tf"), 'data "external" "x" {\n  program = ["sh"]\n}\n');
  writeFileSync(join(dir, "evil.tf.json"), "{}");
  const bad = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^provider: main\.tf:1 /m);
  assert.match(bad.stdout, /^file: evil\.tf\.json:1 /m);
  const good = spawnSync(process.execPath, [SCRIPT, join(LABS, "az104-06-blob-security", "terraform")], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
});
