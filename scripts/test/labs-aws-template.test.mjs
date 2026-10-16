// labs-aws-template.test.mjs
//
// Plain English: labs/_template-aws keeps the AWS contract (AWS labs spec §4):
// exactly the §4 variables, the one allowed provider block, the lab's
// resource group as a tag query on its own id, the template network the
// plan fixtures describe, and the outputs the pipeline reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_TF_VARS_AWS, variablesProblems } from "../lib/labs.mjs";
import { lintDir } from "../../infra/ci/lab-lint.mjs";
import { ctxAws, templateResources } from "./fixtures/labs/plans/common-aws.mjs";

const DIR = fileURLToPath(new URL("../../labs/_template-aws/", import.meta.url));
const text = readdirSync(DIR).filter((f) => f.endsWith(".tf")).map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");

test("the template declares exactly the §4 variables and passes the AWS lint", () => {
  const vars = [...text.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(vars, [...LAB_TF_VARS_AWS]);
  assert.deepEqual(variablesProblems(readFileSync(join(DIR, "variables.tf"), "utf8"), "aws"), []);
  assert.deepEqual(lintDir(DIR, { cloud: "aws" }), []);
});

test("one provider block: the session's region and the lab's tags, nothing else", () => {
  const blocks = [...text.matchAll(/^provider "aws" \{([\s\S]*?)^\}/gm)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(blocks, ["region = var.region default_tags { tags = var.tags }"]);
});

test("the template's resources are the ones the plan fixtures describe", () => {
  const tf = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`).sort();
  const fixture = [...new Set(templateResources(ctxAws("soa-00-template", "00")).map((r) => r.address.replace(/\[\d+\]$/, "")))].sort();
  assert.deepEqual(tf, fixture);
});

test("the resource group queries the lab tag on the lab's own id; outputs are the §4 ones", () => {
  assert.match(text, /name = "lab-\$\{var\.lab_id\}"/);
  assert.match(text, /TagFilters\s+= \[\{ Key = "cloudlabs-lab", Values = \[var\.lab_id\] \}\]/);
  assert.deepEqual([...text.matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]), ["private_ips", "connect", "peer_vpc_id", "peer_route_table_ids"]);
});

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { amiProblems, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";

test("ruling P2: every allowed provider is pinned, and the VPC is the hub", () => {
  const v = readFileSync(join(DIR, "versions.tf"), "utf8");
  for (const [name, version] of [["aws", "~> 6.0"], ["archive", "~> 2.0"], ["random", "~> 3.7"], ["time", "~> 0.13"], ["tls", "~> 4.0"]]) {
    assert.match(v, new RegExp(`${name} = \\{\\s*source\\s+= "hashicorp/${name}"\\s*version = "${version.replace(/[.*~>]/g, (m) => `\\${m}`)}"`), name);
  }
  assert.match(readFileSync(join(DIR, "network.tf"), "utf8"), /tags\s+= \{ Name = "vpc-lab", "cloudlabs-peer" = "hub" \}/);
  assert.deepEqual(templateResources(ctxAws("soa-01-cloudwatch", "01")).find((r) => r.address === "aws_vpc.lab").values.tags, { Name: "vpc-lab", "cloudlabs-peer": "hub" });
});

test("ruling P3: a lab that cannot peer may leave network.tf out; one that can must keep it unchanged", () => {
  const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "aws-content-"));
  try {
    mkdirSync(join(tmp, "_learning"));
    for (const p of ["_template-aws", "soa-01-cloudwatch", "_learning/soa-01-cloudwatch.yaml"]) cpSync(join(LABS, p), join(tmp, p), { recursive: true });
    assert.deepEqual(commonAwsProblems("soa-01-cloudwatch", tmp), []);
    rmSync(join(tmp, "soa-01-cloudwatch", "terraform", "network.tf"));
    assert.ok(commonAwsProblems("soa-01-cloudwatch", tmp).includes("network.tf is missing: a lab that can peer starts from labs/_template-aws/network.tf"));
    const yamlPath = join(tmp, "soa-01-cloudwatch", "lab.yaml");
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(/connectivity: \{ peering: optional, dns_link: false, subnets_used: 1 \}/, 'connectivity: { peering: "off", dns_link: false, subnets_used: 0 }'));
    assert.ok(!commonAwsProblems("soa-01-cloudwatch", tmp).some((p) => p.startsWith("network.tf")));
    writeFileSync(join(tmp, "soa-01-cloudwatch", "terraform", "network.tf"), "# changed\n");
    assert.ok(commonAwsProblems("soa-01-cloudwatch", tmp).includes("network.tf differs from labs/_template-aws/network.tf"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("batch 4 (rulings P9, P11): amiProblems takes al2023_arm64 anywhere, al2023_ireland only under the secondary provider, ubuntu_arm64 only in lab 22", () => {
  const vm = (name, ami, secondary = false) => ({ kind: "resource", labels: ["aws_instance", name], body: `${secondary ? "  provider = aws.secondary\n" : ""}  ami      = data.aws_ssm_parameter.${ami}.insecure_value\n` });
  const param = (name, path, secondary = false) => ({ kind: "data", labels: ["aws_ssm_parameter", name], body: `${secondary ? "  provider = aws.secondary\n" : ""}  name     = "${path}"\n` });
  const AL = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
  const UB = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
  assert.deepEqual(amiProblems("ans-26-edge", [vm("london", "al2023_arm64"), vm("ireland", "al2023_ireland", true), param("al2023_ireland", AL, true)]), []);
  assert.deepEqual(amiProblems("ans-26-edge", [vm("london", "al2023_ireland")]), ["aws_instance.london: ami is not data.aws_ssm_parameter.al2023_arm64.insecure_value"]);
  assert.deepEqual(amiProblems("ans-29-multi-region", [param("al2023_ireland", AL)]), ['data "aws_ssm_parameter" "al2023_ireland" must be the AL2023 arm64 parameter under provider = aws.secondary']);
  assert.deepEqual(amiProblems("ans-22-s2s-vpn", [vm("router", "ubuntu_arm64"), param("ubuntu_arm64", UB)]), []);
  assert.equal(amiProblems("ans-21-transit-gateway", [vm("router", "ubuntu_arm64"), param("ubuntu_arm64", UB)]).length, 2, "Ubuntu only in PUBLIC_INSTANCE_LABS");
});
