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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudOfId, lintTfText } from "../lib/labs.mjs";
import fs from "node:fs";
import { AWS_GATEWAY_NAMES, fileProblems, lintBicepText, lintDir } from "../../infra/ci/lab-lint.mjs";
import { GATEWAY_NAME_LIST } from "../../infra/ci/lab-scope-aws.mjs";
import { labFolders } from "../lib/labs.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../infra/ci/lab-lint.mjs", import.meta.url));
const VERSIONS = (providers) => `terraform {\n  required_providers {\n${providers}\n  }\n}\n`;
const AZURERM = '    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 4.0"\n    }';
const rules = (files) => [...new Set(lintTfText(files).map((p) => p.rule))].sort();

const aws = (files) => lintTfText(files, { cloud: "aws" }).map((p) => `${p.rule}: ${p.message}`);
const AWS_OK = 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.0" }\n  }\n}\nprovider "aws" {\n  region = var.region\n  default_tags {\n    tags = var.tags\n  }\n}\n';

test("every lab and both templates pass, each by its own cloud", () => {
  for (const folder of labFolders(LABS)) {
    const cloud = cloudOfId(folder);
    assert.deepEqual(lintDir(join(LABS, folder, "terraform"), { cloud }), [], folder);
  }
  assert.deepEqual(lintDir(join(LABS, "_template")), [], "_template");
  assert.deepEqual(lintDir(join(LABS, "_template-aws"), { cloud: "aws" }), []);
});

test("AWS: aws, random, time, tls and archive by full source address; azurerm is refused", () => {
  assert.deepEqual(aws({ "main.tf": AWS_OK }), []);
  assert.ok(aws({ "main.tf": 'terraform {\n  required_providers {\n    azurerm = { source = "hashicorp/azurerm" }\n  }\n}\n' }).some((p) => p.startsWith("provider:")));
  assert.ok(aws({ "main.tf": 'terraform {\n  required_providers {\n    aws = { source = "evil/aws" }\n  }\n}\n' }).some((p) => p.startsWith("provider:")));
});

test("AWS: a provider block may hold only region, alias and default_tags with var.tags", () => {
  for (const extra of ['profile = "admin"', 'access_key = "x"', 'assume_role {\n    role_arn = "x"\n  }', 'endpoints {\n    s3 = "https://x"\n  }', "skip_credentials_validation = true"]) {
    const tf = AWS_OK.replace("region = var.region", `region = var.region\n  ${extra}`);
    assert.ok(aws({ "main.tf": tf }).some((p) => p.startsWith("aws-provider:")), extra);
  }
  assert.ok(aws({ "main.tf": AWS_OK.replace("tags = var.tags", 'tags = { x = "y" }') }).some((p) => p.startsWith("aws-provider:")));
  assert.ok(aws({ "main.tf": AWS_OK.replace("region = var.region", 'region = "us-east-2"') }).some((p) => p.startsWith("aws-provider:")));
  assert.deepEqual(aws({ "main.tf": `${AWS_OK}provider "aws" {\n  alias  = "secondary"\n  region = var.secondary_region\n  default_tags {\n    tags = var.tags\n  }\n}\n` }), []);
});

test("AWS: literal CIDRs only 0.0.0.0/0 and ::/0", () => {
  assert.deepEqual(aws({ "main.tf": 'locals {\n  a = "0.0.0.0/0"\n  b = "::/0"\n}\n' }), []);
  assert.ok(aws({ "main.tf": 'locals {\n  a = "10.50.0.0/16"\n}\n' }).some((p) => p.startsWith("literal-cidr:")));
  assert.ok(aws({ "main.tf": 'locals {\n  a = "2001:db8::/32"\n}\n' }).some((p) => p.startsWith("literal-cidr:")));
});

test("AWS: the VPN server's names and the wg-admin key are refused; the boundary's name is not", () => {
  // Every Name in infra/aws (final review, Important 3), the same list as the plan check's.
  assert.deepEqual(AWS_GATEWAY_NAMES, GATEWAY_NAME_LIST);
  for (const n of GATEWAY_NAME_LIST) assert.ok(aws({ "main.tf": `locals {\n  x = "${n}"\n}\n` }).some((p) => p.startsWith("gateway:")), n);
  const names = [...fs.readFileSync(new URL("../../infra/aws/main.tf", import.meta.url), "utf8").matchAll(/\bName\s*=\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `${names.length} names read from infra/aws/main.tf`);
  for (const n of names) assert.ok(GATEWAY_NAME_LIST.includes(n), `infra/aws/main.tf's ${n} is not on the list`);
  assert.ok(aws({ "main.tf": 'locals {\n  t = { "wg-admin" = "vpn" }\n}\n' }).some((p) => p.startsWith("gateway:")));
  assert.ok(aws({ "main.tf": 'locals {\n  r = "wg-admin-deploy"\n}\n' }).some((p) => p.startsWith("gateway:")));
  assert.deepEqual(aws({ "main.tf": 'locals {\n  b = "arn:aws:iam::1:policy/wg-admin-lab-boundary"\n}\n' }), []);
});

test("AWS: no data tls_certificate, and archive_file only inside path.module", () => {
  assert.ok(aws({ "main.tf": 'data "tls_certificate" "x" {\n  url = "https://example.com"\n}\n' }).some((p) => p.startsWith("provider:") || p.startsWith("data:")));
  assert.ok(aws({ "main.tf": 'data "archive_file" "x" {\n  type        = "zip"\n  source_file = "/etc/passwd"\n  output_path = "x.zip"\n}\n' }).some((p) => p.startsWith("data:")));
  assert.deepEqual(aws({ "main.tf": 'data "archive_file" "x" {\n  type        = "zip"\n  source_dir  = "${path.module}/src"\n  output_path = "${path.module}/x.zip"\n}\n' }).filter((p) => p.startsWith("data:")), []);
});

test("the command line takes --cloud aws", () => {
  const r = spawnSync(process.execPath, ["infra/ci/lab-lint.mjs", "--cloud", "aws", "labs/_template-aws"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
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

test("cfn (ruling P4): --cloud aws reads terraform/cfn/*.yaml: short-form tags, Transform, IAM types, custom resources, Retain and literal CIDRs are refused; the long form passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-cfn-"));
  mkdirSync(join(dir, "cfn"));
  writeFileSync(join(dir, "main.tf"), "# main.tf\n");
  const good = ["# cfn/stack.yaml", "# Short forms such as !Ref are not read here.", "Resources:", "  Q:", "    Type: AWS::SQS::Queue", "    Properties:", "      VisibilityTimeout:", "        Ref: Timeout", "    DeletionPolicy: Delete", ""].join("\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), good);
  assert.deepEqual(lintDir(dir, { cloud: "aws" }), []);
  const bad = [
    "Transform: AWS::Serverless-2016-10-31",
    "Resources:",
    "  R:",
    "    Type: AWS::IAM::Role",
    "  C:",
    "    Type: Custom::Thing",
    "    DeletionPolicy: Retain",
    "  Q:",
    "    Type: AWS::SQS::Queue",
    "    Properties:",
    "      VisibilityTimeout: !Ref Timeout",
    "      Cidr: 10.1.0.0/16",
    "",
  ].join("\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), bad);
  const got = lintDir(dir, { cloud: "aws" }).map((p) => `${p.rule}: ${p.file}:${p.line}`);
  assert.deepEqual(got.sort(), ["cfn: cfn/stack.yaml:1", "cfn: cfn/stack.yaml:11", "cfn: cfn/stack.yaml:4", "cfn: cfn/stack.yaml:6", "cfn: cfn/stack.yaml:7", "literal-cidr: cfn/stack.yaml:12"].sort());
  // An Azure lab's folder never has its cfn/ read.
  assert.deepEqual(lintDir(dir, { cloud: "azure" }).filter((p) => p.file.startsWith("cfn/")), []);
});

test("re-review N-4 (--cloud aws only): a literal EC2 id, an EC2 alarm action and timestamp()/uuid() are refused in .tf and cfn/ text; Azure labs keep timestamp()", () => {
  const tf = [
    'resource "aws_ssm_association" "x" {',
    '  name = "AWS-StopEC2Instance"',
    '  parameters = { InstanceId = "i-0123456789abcdef0" }',
    "}",
    'resource "aws_cloudwatch_metric_alarm" "a" {',
    '  alarm_actions = ["arn:aws:automate:eu-west-2:ec2:terminate", "arn:aws:swf:eu-west-2:123456789012:action/actions/AWS_EC2.InstanceId.Stop/1.0"]',
    '  dimensions    = { InstanceId = timestamp() == "" ? "x" : "y" }',
    '  alarm_name    = "lab-${uuid()}"',
    '  ok_actions    = [plantimestamp() == "" ? "x" : "y"]',
    '  password      = bcrypt("x")',
    "}",
    "# a comment naming vol-0123456789abcdef0 and timestamp() is not read",
    "",
  ].join("\n");
  const got = lintTfText({ "main.tf": tf }, { cloud: "aws" }).filter((p) => ["known-id", "apply-time"].includes(p.rule)).map((p) => `${p.rule}: ${p.line}`);
  assert.deepEqual(got.sort(), ["apply-time: 7", "apply-time: 8", "apply-time: 9", "apply-time: 10", "known-id: 3", "known-id: 6", "known-id: 6"].sort());
  for (const id of ["vol-0123456789abcdef0", "snap-0123456789abcdef0", "eni-0123abcd", "sg-0123456789abcdef0", "subnet-0123abcd", "vpc-0a1b2c3d4e5f60718", "rtb-0123abcd", "acl-0123abcd"]) {
    assert.deepEqual(lintTfText({ "x.tf": `locals { x = "${id}" }\n` }, { cloud: "aws" }).map((p) => p.rule), ["known-id"], id);
  }
  // Names that only look like ids pass: sg-vms, lt-a03bc1de, vpc-lab, subnet-private-1.
  assert.deepEqual(lintTfText({ "x.tf": 'locals {\n  a = "sg-vms"\n  b = "lt-a03bc1de"\n  c = "vpc-lab"\n  d = "snet-private-1"\n}\n' }, { cloud: "aws" }), []);
  // Azure: timestamp() stays allowed (az104-04-cost's budget start date).
  assert.deepEqual(lintTfText({ "x.tf": 'locals { t = timestamp() }\n' }, { cloud: "azure" }), []);
  // cfn/: the same id and action rules.
  const dir = mkdtempSync(join(tmpdir(), "lint-cfn-id-"));
  mkdirSync(join(dir, "cfn"));
  writeFileSync(join(dir, "main.tf"), "# main.tf\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), ["Resources:", "  A:", "    Type: AWS::CloudWatch::Alarm", "    Properties:", "      Dimensions:", "        - Name: InstanceId", "          Value: i-0123456789abcdef0", "      AlarmActions:", "        - arn:aws:automate:eu-west-2:ec2:stop", ""].join("\n"));
  assert.deepEqual(lintDir(dir, { cloud: "aws" }).map((p) => `${p.rule}: ${p.file}:${p.line}`).sort(), ["known-id: cfn/stack.yaml:7", "known-id: cfn/stack.yaml:9"]);
});

test("cfn (final review I-1): a log group with DeletionProtectionEnabled other than false is refused; false passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-cfn-dp-"));
  mkdirSync(join(dir, "cfn"));
  writeFileSync(join(dir, "main.tf"), "# main.tf\n");
  const tpl = (v) => ["Resources:", "  L:", "    Type: AWS::Logs::LogGroup", "    Properties:", "      RetentionInDays: 1", `      DeletionProtectionEnabled: ${v}`, ""].join("\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), tpl("false"));
  assert.deepEqual(lintDir(dir, { cloud: "aws" }), []);
  writeFileSync(join(dir, "cfn", "stack.yaml"), tpl("true"));
  assert.deepEqual(lintDir(dir, { cloud: "aws" }).map((p) => `${p.rule}: ${p.file}:${p.line}`), ["cfn: cfn/stack.yaml:6"]);
});

test("rulings P4 and P14 (--cloud aws): a literal AMI id and an aws-sdk: workflow integration are refused", () => {
  const tf = ['locals {', '  a = "ami-0123456789abcdef0"', '  b = "arn:aws:states:::aws-sdk:iam:createUser"', '  c = "ami-dr"', '}', ''].join("\n");
  assert.deepEqual(lintTfText({ "x.tf": tf }, { cloud: "aws" }).map((p) => `${p.rule}: ${p.line}`).sort(), ["gateway: 3", "known-id: 2"]);
});
