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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintTfText } from "../lib/labs.mjs";
import { fileProblems, lintBicepText, lintDir } from "../../infra/ci/lab-lint.mjs";
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
  assert.deepEqual(fileProblems(["main.tf", "versions.tf", "cloud-init.yaml.tftpl", "site.bicep", "settings.json"]), []);
  for (const f of ["main.tf.json", "x.auto.tfvars", "terraform.tfvars.json", "terraform.rc", ".terraformrc"]) assert.equal(fileProblems([f])[0]?.rule, "file", f);
});

test("a committed x.json beside x.bicep is refused", () => {
  // The pipeline builds main.json from main.bicep with the pinned Bicep; a committed one would be deployed unchecked by the lint.
  assert.deepEqual(fileProblems(["main.tf", "main.bicep", "main.json", "vnet.bicep"]).map((p) => [p.rule, p.file]), [["file", "main.json"]]);
  assert.deepEqual(fileProblems(["main.tf", "Main.Bicep", "main.JSON"]).map((p) => p.rule), ["file"], "case does not matter");
  assert.deepEqual(fileProblems(["main.tf", "main.bicep", "vnet.bicep"]), []);
  // Through lintDir too, as lab.yml runs it before init.
  const dir = mkdtempSync(join(tmpdir(), "lab-lint-"));
  writeFileSync(join(dir, "main.tf"), "");
  writeFileSync(join(dir, "main.bicep"), "param location string\n");
  writeFileSync(join(dir, "main.json"), "{}");
  assert.deepEqual(lintDir(dir).map((p) => [p.rule, p.file]), [["file", "main.json"]]);
});

test(".bicep files are linted for literal CIDRs and the gateway's names", () => {
  const bicep = [
    "// A comment may say 10.0.0.0/8 or vnet-wg without harm.",
    "/* So may a block comment: 192.168.0.0/16",
    "   rg-wg-ondemand */",
    "param cidr string",
    "var home = 'https://learn.microsoft.com//x' // 172.16.0.0/12",
    "var bad = '10.1.0.0/16'",
    "var anyIp = '0.0.0.0/0'",
    "var esc = 'it\\'s 10.2.0.0/24'",
    "var multi = '''",
    "10.3.0.0/24",
    "'''",
    "resource peer 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' existing = {",
    "  name: 'vnet-lab/to-vnet-wg'",
    "}",
    "",
  ].join("\n");
  const problems = lintBicepText({ "main.bicep": bicep });
  assert.deepEqual(problems.map((p) => [p.rule, p.file, p.line]), [
    ["literal-cidr", "main.bicep", 6],
    ["literal-cidr", "main.bicep", 8],
    ["literal-cidr", "main.bicep", 10],
    ["gateway", "main.bicep", 13],
  ]);
  // Every file in the folder, through lintDir.
  const dir = mkdtempSync(join(tmpdir(), "lab-lint-"));
  writeFileSync(join(dir, "main.tf"), "");
  writeFileSync(join(dir, "vnet.bicep"), "param cidr string\nvar x = '10.9.0.0/16'\n");
  assert.deepEqual(lintDir(dir).map((p) => [p.rule, p.file, p.line]), [["literal-cidr", "vnet.bicep", 2]]);
  // A clean Bicep file: addresses from parameters and cidrSubnet().
  assert.deepEqual(lintBicepText({ "main.bicep": readFileSync(new URL("./fixtures/labs/bicep/vnet.bicep", import.meta.url), "utf8") }), []);
});

test(".bicep may not pull code from elsewhere: registry or template spec modules, extensions or imports", () => {
  const cases = [
    ["module m 'br:mcr.microsoft.com/bicep/avm/res/network/virtual-network:0.1.0' = {\n  name: 'm'\n}\n", "module"],
    ["module m 'br/public:avm/res/network/virtual-network:0.1.0' = {\n  name: 'm'\n}\n", "module"],
    ["module m 'ts:00000000-0000-0000-0000-000000000000/rg/spec:1.0' = {\n  name: 'm'\n}\n", "module"],
    ["module m 'ts/corp:spec:1.0' = {\n  name: 'm'\n}\n", "module"],
    ["extension microsoftGraphV1\n", "provider"],
    ["extension 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:0.1.8-preview'\n", "provider"],
    ["import 'microsoftGraph@1.0.0'\n", "provider"],
    ["provider microsoftGraph\n", "provider"],
  ];
  for (const [src, rule] of cases) assert.deepEqual(lintBicepText({ "main.bicep": src }).map((p) => p.rule), [rule], src);
  // A local module is fine (lab 12 uses one).
  assert.deepEqual(lintBicepText({ "main.bicep": "module vnet 'vnet.bicep' = {\n  name: 'vnet'\n}\n" }), []);
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
