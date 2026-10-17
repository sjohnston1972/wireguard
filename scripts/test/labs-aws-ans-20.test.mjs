// labs-aws-ans-20.test.mjs
//
// Plain English: lab ans-20-vpc-design is the lab AWS labs spec §12.2 row 20
// describes, as ruling P5 builds it: one dual-stack VPC with a secondary
// IPv4 range from the slot, IPv6 from a Free Tier IPAM pool of
// Amazon-provided space, a NAT gateway for IPv4, an egress-only gateway for
// IPv6, and a managed prefix list a security group names (rulings P5, P6,
// A11, A45, A82).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-20-vpc-design";
const body = (blocks, type, name) => blocks.find((b) => b.kind === "resource" && b.labels[0] === type && b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-20 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-20's lab.yaml: §12.2 row 20, about £0.05/h with the NAT gateway billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "associate", "explore", ["ans.design", "ans.implementation"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual([yaml.capacity, yaml.regions], [{ instance_types: ["t4g.nano"] }, { secondary: null }]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.04 && total < 0.055, `about £0.046/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
  for (const n of ["IPAM Free Tier, an Amazon-provided IPv6 pool", "Egress-only internet gateway and prefix list"]) assert.equal(yaml.cost.items.find((i) => i.name === n).gbp_h, 0, n);
});

test("ruling P5: a Free Tier IPAM in the session's region, an Amazon-provided IPv6 pool with a /52, a /56 for vpc-lab; never a literal range", () => {
  const { files, blocks } = awsLab(ID);
  const ipam = files["ipam.tf"];
  for (const re of [/tier\s+= "free"/, /cascade\s+= true/, /operating_regions \{\n\s+region_name = var\.region\n\s+\}/, /address_family\s+= "ipv6"/, /ipam_scope_id\s+= aws_vpc_ipam\.lab\.public_default_scope_id/, /locale\s+= var\.region/, /public_ip_source = "amazon"/, /aws_service\s+= "ec2"/, /netmask_length = 52/, /vpc_id\s+= aws_vpc\.lab\.id/, /ipv6_ipam_pool_id\s+= aws_vpc_ipam_pool\.v6\.id/, /ipv6_netmask_length = 56/, /depends_on\s+= \[aws_vpc_ipam_pool_cidr\.v6\]/]) assert.match(ipam, re);
  assert.doesNotMatch(body(blocks, "aws_vpc_ipam_pool_cidr", "v6"), /^\s*cidr\s*=/m, "a netmask length only: BYOIP is never");
  for (const t of ["aws_vpc_ipam", "aws_vpc_ipam_pool", "aws_vpc_ipam_pool_cidr", "aws_vpc_ipv6_cidr_block_association"]) assert.equal(blocks.filter((b) => b.kind === "resource" && b.labels[0] === t).length, 1, t);
});

test("ans-20's dual stack: the slot's second /20 as a secondary range, three subnets each with a /64, IPv4 out through NAT and IPv6 through the egress-only gateway", () => {
  const { files } = awsLab(ID);
  const dual = files["dual.tf"];
  for (const re of [/secondary_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /vpc_ipv6_cidr\s+= aws_vpc_ipv6_cidr_block_association\.lab\.ipv6_cidr_block/, /cidr_block\s+= local\.secondary_cidr/, /cidrsubnet\(local\.secondary_cidr, 4, count\.index\)/, /cidrsubnet\(local\.vpc_ipv6_cidr, 8, count\.index\)/, /cidrsubnet\(local\.secondary_cidr, 4, 2\)/, /cidrsubnet\(local\.vpc_ipv6_cidr, 8, 2\)/, /destination_ipv6_cidr_block = "::\/0"\n\s+egress_only_gateway_id\s+= aws_egress_only_internet_gateway\.lab\.id/, /destination_ipv6_cidr_block = "::\/0"\n\s+gateway_id\s+= aws_internet_gateway\.lab\.id/, /destination_cidr_block = "0\.0\.0\.0\/0"\n\s+nat_gateway_id\s+= aws_nat_gateway\.lab\.id/, /subnet_id\s+= aws_subnet\.public\.id/]) assert.match(dual, re);
  assert.equal(count(dual, /assign_ipv6_address_on_creation = true/g), 2, "both subnet blocks");
  assert.equal(count(dual, /depends_on\s+= \[aws_vpc_ipv4_cidr_block_association\.secondary\]/g), 2, "subnets wait for the secondary range");
  assert.equal(count(dual, /resource "aws_route"/g), 4);
  assert.equal(count(dual, /resource "aws_nat_gateway"/g), 1);
  assert.doesNotMatch(dual, /map_public_ip_on_launch\s+= true/);
  // Ruling A11: the S3 endpoint stays on rt-private only (network.tf is the template's, unchanged).
  assert.doesNotMatch(dual, /aws_vpc_endpoint"/);
});

test("ruling P6: the prefix list holds only the gateway's range and vpc-lab's; sg-dual names it and admits nothing from the internet", () => {
  const { files, blocks } = awsLab(ID);
  const pl = body(blocks, "aws_ec2_managed_prefix_list", "admin");
  for (const re of [/name\s+= "lab-\$\{var\.lab_id\}-admin"/, /address_family = "IPv4"/, /max_entries\s+= 4/, /cidr\s+= var\.gateway_cidr/, /cidr\s+= local\.vpc_cidr/]) assert.match(pl, re);
  assert.equal(count(pl, /entry \{/g), 2);
  const compute = files["compute.tf"];
  assert.equal(count(compute, /prefix_list_id\s+= aws_ec2_managed_prefix_list\.admin\.id/g), 2, "SSH and HTTP from the list");
  const ingress = blocks.filter((b) => b.kind === "resource" && b.labels[0] === "aws_vpc_security_group_ingress_rule" && b.labels[1].startsWith("dual_"));
  assert.equal(ingress.length, 3);
  for (const b of ingress) assert.doesNotMatch(b.body, /cidr_ipv[46]/, `${b.labels[1]} names no range`);
  for (const re of [/ipv6_address_count\s+= 1/, /subnet_id\s+= aws_subnet\.dual\[0\]\.id/, /--bind :: --directory \/srv\/www/, /instance_type\s+= "t4g\.nano"/]) assert.match(compute, re);
  assert.match(files["dual.tf"], /security_group_id = aws_security_group\.eice\.id\n\s+cidr_ipv4\s+= local\.secondary_cidr/, "eice-lab reaches the secondary range");
});

test("ans-20's outputs: vm-dual's IPv6 address, and both vpc-lab route tables get the route back when peered", () => {
  const { files } = awsLab(ID);
  assert.match(files["outputs.tf"], /"IPv6: \$\{aws_instance\.dual\.ipv6_addresses\[0\]\}"/);
  assert.match(files["outputs.tf"], /value = \[aws_route_table\.private\.id, aws_route_table\.dual\.id\]/);
});

test("ans-20's readme names each piece and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["ipam-lab", "pool-v6", "eigw-lab", "nat-lab", "pl-admin", "snet-dual-1/2", "checkip.amazonaws.com", "Modify prefix list"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
