// labs-aws-contract.test.mjs
//
// Plain English: the AWS half of the lab contract (AWS labs spec §3, §6 first
// bullet, rulings A1-A7): the ids, exams and clouds; lab.yaml's AWS field
// rules, each refused with its field; per-cloud lab numbers and
// prerequisites; and the AWS readme footer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { AWS_LAB_ID_MAX, buildCatalogue, cloudOfId, EXAM_CLOUD, examOfId, LAB_EXAMS, LAB_ID_RE, LAB_TF_VARS_AWS, readmeFooter, validateLab, variablesProblems } from "../lib/labs.mjs";

const AREAS = [
  { key: "soa.reliability", exam: "SOA-C03", name: "Reliability and Business Continuity" },
  { key: "soa.deployment", exam: "SOA-C03", name: "Deployment, Provisioning, and Automation" },
  { key: "saa.resilient", exam: "SAA-C03", name: "Design Resilient Architectures" },
  { key: "az104.compute", exam: "AZ-104", name: "Deploy and manage Azure compute resources" },
];
const EC2 = { service: "AmazonEC2", unit: "Hrs", filters: { instanceType: "t4g.micro", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" } };
const awsLab = (over = {}) => ({
  id: "soa-03-auto-scaling", version: 1, cloud: "aws", title: "Auto Scaling behind an Application Load Balancer", summary: "A launch template and an Auto Scaling group.",
  exam: "SOA-C03", skill_areas: ["soa.reliability", "soa.deployment", "saa.resilient"], level: "associate", type: "explore", prerequisites: [],
  cost: { items: [
    { name: "EC2 t4g.micro, Linux (2 running)", gbp_h: 0.0071, qty: 2, aws_price: EC2 },
    { name: "Application Load Balancer, hourly", gbp_h: 0.0199, whole_hours: true, aws_price: { service: "AWSELB", unit: "Hrs", filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } } },
    { name: "EBS gp3 root volume, 8 GiB", gbp_h: 0.0008, qty: 2, aws_price: { service: "AmazonEC2", unit: "GB-Mo", gb: 8, filters: { productFamily: "Storage", volumeApiName: "gp3" } } },
  ], pricey: null },
  timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 },
  capacity: { instance_types: ["t4g.micro", "t4g.micro"] },
  regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});
const azureLab = (over = {}) => ({
  id: "az104-08-vms", version: 1, title: "VMs", summary: "Two VMs.", exam: "AZ-104", skill_areas: ["az104.compute"], level: "associate", type: "explore", prerequisites: [],
  cost: { items: [{ name: "Linux VM, Standard_B1s", gbp_h: 0.0092, qty: 2, retail: { sku: "Standard_B1s" } }], pricey: null },
  timing: { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 6 }, capacity: { vm_sizes: ["Standard_B1s", "Standard_B1s"] }, regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: false, subnets_used: 1 }, identity: { creates: [], roles: [], governance: false }, ...over,
});
const problemsOf = (raw) => validateLab(raw, { folder: raw.id, skillAreas: AREAS }).problems;
/** The lab with its first cost item changed by f. */
const firstItem = (lab, f) => ({ ...lab, cost: { ...lab.cost, items: lab.cost.items.map((i, n) => (n === 0 ? f(i) : i)) } });

test("the id pattern takes the AWS prefixes and refuses the rest (A1)", () => {
  for (const ok of ["soa-03-auto-scaling", "saa-11-three-tier", "ans-31-client-vpn", "az104-06-blob-security", "az700-44-flow-logs-bastion"]) assert.ok(LAB_ID_RE.test(ok), ok);
  for (const bad of ["soc-01-x", "sa-01-x", "aws-01-x", "ans-1-x", "SOA-01-x", "soa-01-", "soa-01-x_y"]) assert.ok(!LAB_ID_RE.test(bad), bad);
  assert.equal(AWS_LAB_ID_MAX, 30);
});

test("six exams in catalogue order, each with its cloud, read from the id", () => {
  assert.deepEqual([...LAB_EXAMS], ["AZ-104", "AZ-305", "AZ-700", "SOA-C03", "SAA-C03", "ANS-C01"]);
  assert.deepEqual(Object.fromEntries(LAB_EXAMS.map((e) => [e, EXAM_CLOUD[e]])), { "AZ-104": "azure", "AZ-305": "azure", "AZ-700": "azure", "SOA-C03": "aws", "SAA-C03": "aws", "ANS-C01": "aws" });
  assert.deepEqual(["soa-01-x", "saa-11-x", "ans-20-x", "az305-20-x"].map(examOfId), ["SOA-C03", "SAA-C03", "ANS-C01", "AZ-305"]);
  assert.deepEqual(["soa-01-x", "az104-01-x"].map(cloudOfId), ["aws", "azure"]);
});

test("a good AWS lab validates, with cloud aws and an empty vm_sizes", () => {
  const r = validateLab(awsLab(), { folder: "soa-03-auto-scaling", skillAreas: AREAS });
  assert.deepEqual(r.problems, []);
  assert.equal(r.def.cloud, "aws");
  assert.deepEqual(r.def.capacity, { vm_sizes: [], instance_types: ["t4g.micro", "t4g.micro"] });
  assert.deepEqual(r.def.exams, ["SOA-C03", "SAA-C03"]);
});

test("an Azure lab without cloud is cloud azure with an empty instance_types", () => {
  const r = validateLab(azureLab(), { folder: "az104-08-vms", skillAreas: AREAS });
  assert.deepEqual(r.problems, []);
  assert.equal(r.def.cloud, "azure");
  assert.deepEqual(r.def.capacity, { vm_sizes: ["Standard_B1s", "Standard_B1s"], instance_types: [] });
});

// [what, raw lab, field, message pattern]
const REFUSED = [
  ["an AWS id without cloud: aws", awsLab({ cloud: undefined }), "cloud", /soa-03-auto-scaling is an AWS lab: set cloud: aws/],
  ["cloud: aws on an Azure id", azureLab({ cloud: "aws" }), "cloud", /cloud aws does not match the id az104-08-vms \(an azure lab\)/],
  ["an AWS id over 30 characters", awsLab({ id: `soa-03-${"a".repeat(24)}` }), "id", /longer than 30 characters/],
  ["an exam that is not the id's", awsLab({ exam: "SAA-C03" }), "exam", /does not match the id/],
  ["an Azure area on an AWS lab", awsLab({ skill_areas: ["soa.reliability", "az104.compute"] }), "skill_areas", /az104\.compute is an AZ-104 area: an AWS lab names only AWS exams' areas/],
  ["retail on an AWS item", firstItem(awsLab(), (i) => ({ ...i, retail: { sku: "Standard_B1s" } })), "cost.items", /retail is Azure's list price: an AWS lab uses aws_price/],
  ["GB-Mo without gb", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, unit: "GB-Mo" } })), "cost.items", /unit GB-Mo needs gb/],
  ["gb with Hrs", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, gb: 8 } })), "cost.items", /gb goes with unit GB-Mo/],
  ["an instanceType not in instance_types", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: { ...EC2.filters, instanceType: "t3.small" } } })), "capacity.instance_types", /t3\.small: list it in capacity\.instance_types too/],
  ["{usage} outside usagetype", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: { ...EC2.filters, operatingSystem: "{usage}" } } })), "cost.items", /\{usage\} only in a usagetype filter/],
  ["empty filters", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: {} } })), "cost.items", /filters needs at least one/],
  ["vm_sizes on an AWS lab", awsLab({ capacity: { vm_sizes: ["Standard_B1s"], instance_types: ["t4g.micro", "t4g.micro"] } }), "capacity.vm_sizes", /an AWS lab lists capacity\.instance_types, not vm_sizes/],
  ["no instance_types on an AWS lab", awsLab({ capacity: {} }), "capacity.instance_types", /an AWS lab lists capacity\.instance_types/],
  ["an instance type off the list", awsLab({ capacity: { instance_types: ["m5.large"] } }), "capacity.instance_types", /m5\.large is not an allowed instance type/],
  ["t4g.medium outside saa-19-eks", awsLab({ capacity: { instance_types: ["t4g.medium"] } }), "capacity.instance_types", /t4g\.medium is only for saa-19-eks/],
  ["a secondary region other than Ireland", awsLab({ regions: { secondary: "us-east-1" } }), "regions.secondary", /null or eu-west-1/],
  ["dns_link on an AWS lab (A8)", awsLab({ connectivity: { peering: "optional", dns_link: true, subnets_used: 1 } }), "connectivity.dns_link", /dns_link is always false for an AWS lab/],
  ["a user outside soa-07", awsLab({ identity: { creates: ["user"], roles: [], governance: false } }), "identity.creates", /only soa-07-iam-kms may create an IAM user/],
  ["group on an AWS lab", awsLab({ identity: { creates: ["group"], roles: [], governance: false } }), "identity.creates", /an AWS lab creates role or user/],
  ["roles on an AWS lab", awsLab({ identity: { creates: [], roles: [{ role: "Reader", scope: "resource_group" }], governance: false } }), "identity.roles", /always \[\] for an AWS lab/],
  ["governance on an AWS lab", awsLab({ identity: { creates: [], roles: [], governance: true } }), "identity.governance", /always false for an AWS lab/],
  ["aws_price on an Azure item", firstItem(azureLab(), (i) => ({ ...i, aws_price: EC2 })), "cost.items", /aws_price is AWS's list price: an Azure lab uses retail/],
  ["whole_hours on an Azure item", firstItem(azureLab(), (i) => ({ ...i, whole_hours: true })), "cost.items", /whole_hours is for AWS items/],
  ["instance_types on an Azure lab", azureLab({ capacity: { vm_sizes: ["Standard_B1s"], instance_types: ["t4g.micro"] } }), "capacity.instance_types", /an Azure lab lists capacity\.vm_sizes, not instance_types/],
  ["role on an Azure lab", azureLab({ identity: { creates: ["role"], roles: [], governance: false } }), "identity.creates", /an Azure lab creates user or group/],
];
for (const [what, raw, field, re] of REFUSED) {
  test(`refused with its field: ${what}`, () => {
    const p = problemsOf(raw);
    assert.ok(p.some((x) => x.field === field && re.test(x.message)), `${field} ${re}: got ${JSON.stringify(p)}`);
  });
}

test("the AWS readme footer names the tag (A9); an Azure id keeps its footer", () => {
  assert.equal(readmeFooter("soa-01-cloudwatch"), "Everything this lab builds carries the tag `cloudlabs-lab = soa-01-cloudwatch` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.");
  assert.match(readmeFooter("az104-08-vms"), /^Anything you build by hand inside `rg-lab-az104-08-vms`/);
});

test("an AWS variables.tf may declare gateway_cidr but not resource_group_name", () => {
  assert.deepEqual([...LAB_TF_VARS_AWS], ["lab_id", "name_prefix", "region", "secondary_region", "address_space", "gateway_cidr", "peered", "admin_password", "ssh_public_key", "tags"]);
  assert.deepEqual(variablesProblems('variable "gateway_cidr" {}\nvariable "tags" {}', "aws"), []);
  assert.equal(variablesProblems('variable "resource_group_name" {}', "aws").length, 1);
  assert.equal(variablesProblems('variable "gateway_cidr" {}', "azure").length, 1);
});

/** A labs folder with the skill areas and the given labs (each a raw lab.yaml), each with a minimal good readme. */
function root(labs) {
  const dir = mkdtempSync(join(tmpdir(), "labs-aws-"));
  writeFileSync(join(dir, "skill-areas.yaml"), stringify(AREAS));
  for (const raw of labs) {
    mkdirSync(join(dir, raw.id));
    writeFileSync(join(dir, raw.id, "lab.yaml"), stringify(raw));
    writeFileSync(join(dir, raw.id, "readme.md"), `Intro.\n\n## What it deploys\n\n- a thing\n\n## Things to try\n\n- one\n- two\n- three\n\n## Learn more\n\n- [Docs](https://docs.aws.amazon.com/)\n\n${readmeFooter(raw.id)}\n`);
  }
  return dir;
}

test("numbers are unique per cloud (A3); prerequisites stay in their cloud; AWS labs sort after Azure", () => {
  const ok = buildCatalogue(root([awsLab({ id: "soa-08-x" }), azureLab()]));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.catalogue.labs.map((l) => l.id), ["az104-08-vms", "soa-08-x"]);
  const twice = buildCatalogue(root([awsLab({ id: "soa-08-x" }), awsLab({ id: "saa-08-y", exam: "SAA-C03", skill_areas: ["saa.resilient"] })]));
  assert.ok(twice.problems.some((p) => p.field === "id" && /lab number 8 is also used by/.test(p.message)));
  const cross = buildCatalogue(root([awsLab({ id: "soa-03-x", prerequisites: ["az104-08-vms"] }), azureLab()]));
  assert.ok(cross.problems.some((p) => p.field === "prerequisites" && /az104-08-vms is an Azure lab: prerequisites are labs of the same cloud/.test(p.message)));
});
