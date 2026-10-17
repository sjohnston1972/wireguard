// labs-aws-ans-21.test.mjs
//
// Plain English: lab ans-21-transit-gateway is the lab AWS labs spec §12.2
// row 21 describes: a transit gateway with three VPC attachments (two
// spokes and an egress VPC), segmented route tables with a blackhole route,
// appliance mode on the egress attachment, and one NAT gateway in the
// egress VPC shared by both spokes (ruling P15).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-21-transit-gateway";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-21 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-21's lab.yaml: §12.2 row 21, after lab 20, three /20s, about £0.16/h with the attachments and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 3 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.15 && total < 0.18, `about £0.163/h, got ${total}`);
  const tgw = yaml.cost.items.find((i) => i.name === "Transit gateway VPC attachments (3), hourly");
  assert.deepEqual([tgw.qty, tgw.whole_hours, tgw.aws_price.filters.usagetype], [3, true, "{usage}-TransitGateway-Hours"]);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
});

test("ruling P15: one transit gateway, its default table off, nothing shared, three attachments of the lab's own VPCs, appliance mode on the egress one only", () => {
  const { blocks, files } = awsLab(ID);
  const tgw = body(blocks, "aws_ec2_transit_gateway", "lab");
  for (const re of [/auto_accept_shared_attachments\s+= "disable"/, /default_route_table_association = "disable"/, /default_route_table_propagation = "disable"/, /amazon_side_asn\s+= 64512/]) assert.match(tgw, re);
  const att = of(blocks, "aws_ec2_transit_gateway_vpc_attachment");
  assert.deepEqual(att.map((b) => b.labels[1]).sort(), ["egress", "spoke_a", "spoke_b"]);
  for (const b of att) {
    assert.match(b.body, /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/);
    assert.match(b.body, /transit_gateway_default_route_table_association = false/);
    assert.match(b.body, /transit_gateway_default_route_table_propagation = false/);
  }
  assert.match(body(blocks, "aws_ec2_transit_gateway_vpc_attachment", "egress"), /appliance_mode_support\s+= "enable"/);
  assert.equal(count(files["tgw.tf"], /appliance_mode_support/g), 1);
  assert.equal(of(blocks, "aws_ec2_transit_gateway").length, 1);
});

test("ans-21's segmentation: spokes to egress and spoke B blackholed in tgw-rt-spokes; both spokes propagated into tgw-rt-egress", () => {
  const { blocks } = awsLab(ID);
  const assoc = Object.fromEntries(of(blocks, "aws_ec2_transit_gateway_route_table_association").map((b) => [b.labels[1], b.body.match(/transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.(\w+)\.id/)[1]]));
  assert.deepEqual(assoc, { spoke_a: "spokes", spoke_b: "spokes", egress: "egress" });
  const prop = of(blocks, "aws_ec2_transit_gateway_route_table_propagation");
  assert.deepEqual(prop.map((b) => b.labels[1]).sort(), ["spoke_a", "spoke_b"]);
  for (const b of prop) assert.match(b.body, /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.egress\.id/);
  const dflt = body(blocks, "aws_ec2_transit_gateway_route", "spokes_default");
  for (const re of [/destination_cidr_block\s+= "0\.0\.0\.0\/0"/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_vpc_attachment\.egress\.id/, /aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(dflt, re);
  const hole = body(blocks, "aws_ec2_transit_gateway_route", "spokes_blackhole_b");
  for (const re of [/destination_cidr_block\s+= local\.spoke_b_cidr/, /blackhole\s+= true/, /aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(hole, re);
  assert.doesNotMatch(hole, /transit_gateway_attachment_id/);
});

test("ans-21's VPCs and routes: spoke B and egress are the slot's second and third /20s; each VPC route to the transit gateway waits for its attachment; one NAT gateway", () => {
  const { blocks, files, tf } = awsLab(ID);
  assert.match(files["spoke-b.tf"], /spoke_b_cidr = cidrsubnet\(var\.address_space, 2, 1\)/);
  assert.match(files["egress.tf"], /egress_cidr = cidrsubnet\(var\.address_space, 2, 2\)/);
  assert.equal(count(tf, /resource "aws_nat_gateway"/g), 1);
  assert.match(body(blocks, "aws_nat_gateway", "egress"), /subnet_id\s+= aws_subnet\.egress_public\.id/);
  assert.match(body(blocks, "aws_route", "egress_tgw_nat"), /nat_gateway_id\s+= aws_nat_gateway\.egress\.id/);
  const toTgw = { spoke_a_default: "spoke_a", spoke_b_default: "spoke_b", egress_public_slot: "egress" };
  for (const [route, attachment] of Object.entries(toTgw)) {
    const b = body(blocks, "aws_route", route);
    assert.match(b, /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/, route);
    assert.match(b, new RegExp(`depends_on\\s+= \\[aws_ec2_transit_gateway_vpc_attachment\\.${attachment}\\]`), route);
  }
  assert.match(body(blocks, "aws_route", "egress_public_slot"), /destination_cidr_block = var\.address_space/);
  for (const sg of ["vms_a", "vms_b"]) for (const proto of ["icmp", "tcp"]) assert.ok(of(blocks, "aws_vpc_security_group_ingress_rule").some((b) => b.body.includes(`aws_security_group.${sg}.id`) && /cidr_ipv4\s+= var\.address_space/.test(b.body) && b.body.includes(`"${proto}"`)), `${sg} ${proto}`);
});

test("ans-21's readme explains segmentation and central egress, names what is not built, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["tgw-rt-spokes", "tgw-rt-egress", "blackhole", "nat-egress", "Appliance mode support", "Cloud WAN", "AWS RAM", "checkip.amazonaws.com"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
