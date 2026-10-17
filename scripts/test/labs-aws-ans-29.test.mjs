// labs-aws-ans-29.test.mjs
//
// Plain English: lab ans-29-multi-region is the lab AWS labs spec §12.2
// row 29 describes: a transit gateway and a VPC in London and in Ireland,
// joined by a transit gateway peering attachment with static routes and by
// an inter-Region VPC peering between the same VPCs, one Ireland instance
// behind each path (rulings P1, P3, P15, P18).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, AWS_PEER_REGION_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-29-multi-region";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";

test("ans-29 keeps the AWS lab contract; Ireland's instances read Ireland's copy of the AL2023 parameter (Task 3's amiProblems)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { blocks } = awsLab(ID);
  const param = blocks.find((b) => b.kind === "data" && b.labels[1] === "al2023_ireland").body;
  assert.match(param, /provider = aws\.secondary\n\s+name\s+= "\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-arm64"/);
  for (const k of ["ireland_tgw", "ireland_pcx"]) assert.match(body(blocks, "aws_instance", k), /ami\s+= data\.aws_ssm_parameter\.al2023_ireland\.insecure_value/, k);
});

test("ruling P1: ans-29 is the one peer-region lab; Ireland is its secondary region", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.deepEqual(AWS_PEER_REGION_LABS, [ID]);
  assert.ok(!AWS_GLOBAL_LABS.includes(ID) && !AWS_DNS_LABS.includes(ID));
});

test("ans-29's lab.yaml: §12.2 row 29, after lab 21, about £0.16/h with four attachments billed by the whole hour (two in Ireland)", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation"], ["ans-21-transit-gateway"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.15 && total < 0.18, `about £0.163/h, got ${total}`);
  const tgw = yaml.cost.items.filter((i) => i.name.startsWith("Transit gateway attachments"));
  assert.deepEqual(tgw.map((i) => [i.qty, i.whole_hours, i.region ?? "london", i.aws_price]), [[2, true, "london", undefined], [2, true, "secondary", undefined]]);
  assert.equal(yaml.cost.items.filter((i) => i.region === "secondary").length, 3);
});

test("ans-29's Ireland: the secondary provider exactly as §4, its own resource group, VPC in the slot's second /20, every resource through aws.secondary", () => {
  const { files, blocks } = awsLab(ID);
  const ie = files["ireland.tf"];
  assert.match(ie, /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  assert.match(files["london.tf"], /ireland_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/);
  const inIreland = blocks.filter((b) => (b.kind === "resource" || b.kind === "data") && ie.includes(`"${b.labels[0]}" "${b.labels[1]}" {`));
  assert.equal(inIreland.length, 21, "2 data sources and 19 resources");
  for (const b of inIreland) assert.match(b.body, /^\s*provider\s+= aws\.secondary$/m, `${b.labels.join(".")}`);
  for (const k of ["ireland_tgw", "ireland_pcx", "vms_ireland"]) assert.match(body(blocks, k === "vms_ireland" ? "aws_security_group" : "aws_instance", k), /provider\s+= aws\.secondary/, k);
  for (const re of [/amazon_side_asn\s+= 64513/, /default_route_table_association = "disable"/, /default_route_table_propagation = "disable"/, /auto_accept_shared_attachments\s+= "disable"/]) assert.match(body(blocks, "aws_ec2_transit_gateway", "ireland"), re);
  assert.match(body(blocks, "aws_ec2_transit_gateway", "london"), /amazon_side_asn\s+= 64512/);
  assert.match(body(blocks, "aws_ec2_transit_gateway", "london"), /default_route_table_association = "disable"/);
});

test("rulings P3, P15 and P18: London requests both peerings to Ireland, Ireland accepts both through aws.secondary, static routes wait for the accept", () => {
  const { blocks } = awsLab(ID);
  const tgwp = body(blocks, "aws_ec2_transit_gateway_peering_attachment", "london_ireland");
  for (const re of [/transit_gateway_id\s+= aws_ec2_transit_gateway\.london\.id/, /peer_region\s+= var\.secondary_region/, /peer_transit_gateway_id = aws_ec2_transit_gateway\.ireland\.id/]) assert.match(tgwp, re);
  assert.doesNotMatch(tgwp, /provider|peer_account_id/);
  const tgwa = body(blocks, "aws_ec2_transit_gateway_peering_attachment_accepter", "ireland");
  for (const re of [/provider\s+= aws\.secondary/, /transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment\.london_ireland\.id/]) assert.match(tgwa, re);
  const l2i = body(blocks, "aws_ec2_transit_gateway_route", "london_to_ireland");
  for (const re of [/destination_cidr_block\s+= local\.ireland_cidr/, /transit_gateway_route_table_id\s+= aws_ec2_transit_gateway_route_table\.london\.id/, /depends_on\s+= \[aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\]/]) assert.match(l2i, re);
  const i2l = body(blocks, "aws_ec2_transit_gateway_route", "ireland_to_london");
  for (const re of [/provider\s+= aws\.secondary/, /destination_cidr_block\s+= local\.vpc_cidr/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\.id/, /transit_gateway_route_table_id\s+= aws_ec2_transit_gateway_route_table\.ireland\.id/]) assert.match(i2l, re);
  const pcx = body(blocks, "aws_vpc_peering_connection", "london_ireland");
  for (const re of [/vpc_id\s+= aws_vpc\.lab\.id/, /peer_vpc_id = aws_vpc\.ireland\.id/, /peer_region = var\.secondary_region/, /auto_accept = false/]) assert.match(pcx, re);
  assert.doesNotMatch(pcx, /peer_owner_id/);
  for (const re of [/provider\s+= aws\.secondary/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/, /auto_accept\s+= true/]) assert.match(body(blocks, "aws_vpc_peering_connection_accepter", "ireland"), re);
});

test("the AWS-made default route tables are off: each side has its own tagged route table, with the VPC and peering attachments associated and the VPC propagated (the lab role never writes into an untagged table)", () => {
  const { blocks } = awsLab(ID);
  for (const k of ["london", "ireland"]) {
    const vpcAtt = body(blocks, "aws_ec2_transit_gateway_vpc_attachment", k);
    assert.match(vpcAtt, /transit_gateway_default_route_table_association = false/, k);
    assert.match(vpcAtt, /transit_gateway_default_route_table_propagation = false/, k);
    assert.match(body(blocks, "aws_ec2_transit_gateway_route_table", k), new RegExp("tgw-rt-" + k), k);
    assert.match(body(blocks, "aws_ec2_transit_gateway_route_table_association", k + "_vpc"), new RegExp("aws_ec2_transit_gateway_route_table\." + k + "\.id"), k);
    assert.match(body(blocks, "aws_ec2_transit_gateway_route_table_propagation", k + "_vpc"), new RegExp("aws_ec2_transit_gateway_vpc_attachment\." + k + "\.id"), k);
  }
  assert.match(body(blocks, "aws_ec2_transit_gateway_route_table", "ireland"), /provider\s+= aws\.secondary/);
  assert.match(body(blocks, "aws_ec2_transit_gateway_route_table_association", "london_peering"), /depends_on\s+= \[aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\]/);
  const ip = body(blocks, "aws_ec2_transit_gateway_route_table_association", "ireland_peering");
  for (const re of [/provider\s+= aws\.secondary/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\.id/]) assert.match(ip, re);
});

test("ruling P18: each Ireland subnet is reached one way and answers the same way", () => {
  const { blocks } = awsLab(ID);
  for (const re of [/destination_cidr_block = local\.ireland_tgw_subnet/, /transit_gateway_id\s+= aws_ec2_transit_gateway\.london\.id/, /depends_on\s+= \[aws_ec2_transit_gateway_vpc_attachment\.london\]/]) assert.match(body(blocks, "aws_route", "london_to_ireland_tgw"), re);
  for (const re of [/destination_cidr_block\s+= local\.ireland_pcx_subnet/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/, /depends_on\s+= \[aws_vpc_peering_connection_accepter\.ireland\]/]) assert.match(body(blocks, "aws_route", "london_to_ireland_pcx"), re);
  for (const re of [/route_table_id\s+= aws_route_table\.ireland_tgw\.id/, /transit_gateway_id\s+= aws_ec2_transit_gateway\.ireland\.id/]) assert.match(body(blocks, "aws_route", "ireland_tgw_to_london"), re);
  for (const re of [/route_table_id\s+= aws_route_table\.ireland_pcx\.id/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/]) assert.match(body(blocks, "aws_route", "ireland_pcx_to_london"), re);
  assert.match(body(blocks, "aws_ec2_transit_gateway_vpc_attachment", "ireland"), /subnet_ids\s+= \[aws_subnet\.ireland_tgw\.id, aws_subnet\.ireland_pcx\.id\]/);
});

test("ans-29's readme compares the two paths, and its learning content is valid", () => {
  const { readme, learning, yaml, files } = awsLab(ID);
  for (const s of ["tgwp-london-ireland", "pcx-london-ireland", "static", "propagated", "eu-west-1", "never transitive"]) assert.ok(readme.includes(s), s);
  assert.match(files["outputs.tf"], /--region \$\{var\.secondary_region\} --instance-id \$\{aws_instance\.ireland_tgw\.id\}/);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
