// labs-aws-ans-27.test.mjs
//
// Plain English: lab ans-27-network-firewall is the lab AWS labs spec §12.2
// row 27 describes: two spokes and an inspection VPC on a transit gateway in
// appliance mode, a Network Firewall in one zone with a stateless and a
// stateful rule group, NAT in the inspection VPC, and alert logs in the
// lab's own bucket (rulings P8, P15, P16, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-27-network-firewall";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-27 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-27's lab.yaml: §12.2 row 27, after ans-21, three /20s, about £0.48/h with the firewall, attachments and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.security", "ans.design"], ["ans-21-transit-gateway"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 15, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 3 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.45 && total < 0.51, `about £0.48/h, got ${total}`);
  for (const n of ["Network Firewall endpoint, one AZ", "Transit gateway VPC attachments (2 spokes and the inspection VPC)", "NAT gateway, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("ruling P15: the transit gateway's defaults are off; spokes go to the inspection attachment, which alone is in appliance mode and learns both spokes", () => {
  const { lab } = awsLab(ID);
  const tgw = block(lab, "aws_ec2_transit_gateway", "lab");
  for (const re of [/default_route_table_association = "disable"/, /default_route_table_propagation = "disable"/, /auto_accept_shared_attachments\s+= "disable"/]) assert.match(tgw, re);
  assert.deepEqual(resources(lab, "aws_ec2_transit_gateway_vpc_attachment").map((r) => r.labels[1]).sort(), ["inspection", "spoke_a", "spoke_b"]);
  assert.match(block(lab, "aws_ec2_transit_gateway_vpc_attachment", "inspection"), /appliance_mode_support\s+= "enable"/);
  for (const s of ["spoke_a", "spoke_b"]) assert.doesNotMatch(block(lab, "aws_ec2_transit_gateway_vpc_attachment", s), /appliance_mode_support/, s);
  for (const s of ["spoke_a", "spoke_b"]) assert.match(block(lab, "aws_ec2_transit_gateway_route_table_propagation", s), /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.inspection\.id/, s);
  const r = block(lab, "aws_ec2_transit_gateway_route", "spokes_default");
  for (const re of [/destination_cidr_block\s+= "0\.0\.0\.0\/0"/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_vpc_attachment\.inspection\.id/, /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(r, re);
});

test("the inspection VPC sends both directions through the firewall endpoint, read from the firewall's own status", () => {
  const { lab, tf } = awsLab(ID);
  assert.doesNotMatch(tf, /local\.fw_endpoint/);
  for (const r of ["insp_tgw_default", "insp_public_slot"]) assert.match(block(lab, "aws_route", r), /vpc_endpoint_id\s+= one\(\[for s in aws_networkfirewall_firewall\.lab\.firewall_status\[0\]\.sync_states : s\.attachment\[0\]\.endpoint_id\]\)/, r);
  assert.match(block(lab, "aws_route", "insp_public_slot"), /destination_cidr_block = var\.address_space/);
  assert.match(block(lab, "aws_route", "insp_firewall_slot"), /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/);
  assert.match(block(lab, "aws_route", "insp_firewall_default"), /nat_gateway_id\s+= aws_nat_gateway\.inspection\.id/);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("ruling P16: one subnet mapping, no protections, capacities within 100, ICMP B to A dropped, a domain allow-list in strict order, drop established", () => {
  const { lab, tf } = awsLab(ID);
  const fw = block(lab, "aws_networkfirewall_firewall", "lab");
  assert.equal([...fw.matchAll(/subnet_mapping \{/g)].length, 1);
  for (const k of ["delete_protection", "subnet_change_protection", "firewall_policy_change_protection"]) assert.match(fw, new RegExp(`${k}\\s+= false`), k);
  for (const [g, cap] of [["stateless", 10], ["domains", 100]]) assert.match(block(lab, "aws_networkfirewall_rule_group", g), new RegExp(`capacity\\s+= ${cap}\\n`), g);
  const sl = block(lab, "aws_networkfirewall_rule_group", "stateless");
  for (const re of [/actions = \["aws:drop"\][\s\S]*protocols = \[1\][\s\S]*address_definition = local\.spoke_b_cidr[\s\S]*address_definition = local\.vpc_cidr/, /actions = \["aws:forward_to_sfe"\]/]) assert.match(sl, re);
  const dl = block(lab, "aws_networkfirewall_rule_group", "domains");
  for (const re of [/generated_rules_type = "ALLOWLIST"/, /target_types\s+= \["HTTP_HOST", "TLS_SNI"\]/, /targets\s+= \["\.amazonaws\.com", "\.amazon\.com", "\.ubuntu\.com"\]/, /key = "HOME_NET"/, /definition = \[var\.address_space\]/, /rule_order = "STRICT_ORDER"/]) assert.match(dl, re);
  const pol = block(lab, "aws_networkfirewall_firewall_policy", "lab");
  for (const re of [/stateful_default_actions\s+= \["aws:drop_established", "aws:alert_established"\]/, /rule_order = "STRICT_ORDER"/, /resource_arn = aws_networkfirewall_rule_group\.stateless\.arn/, /resource_arn = aws_networkfirewall_rule_group\.domains\.arn/]) assert.match(pol, re);
  assert.doesNotMatch(tf, /tls_inspection_configuration/);
});

test("rulings P8 and P21: alerts go to the lab's bucket through an explicit policy naming this account, after a 20-second wait", () => {
  const { lab } = awsLab(ID);
  const log = block(lab, "aws_networkfirewall_logging_configuration", "lab");
  for (const re of [/log_destination_type = "S3"/, /log_type\s+= "ALERT"/, /bucketName = aws_s3_bucket\.nfwlogs\.bucket/, /prefix\s+= "alerts"/, /depends_on = \[time_sleep\.firewall_tags, aws_s3_bucket_policy\.nfwlogs\]/]) assert.match(log, re);
  assert.doesNotMatch(log, /CloudWatchLogs|KinesisDataFirehose/);
  assert.match(block(lab, "time_sleep", "firewall_tags"), /create_duration = "20s"/);
  const pol = block(lab, "aws_s3_bucket_policy", "nfwlogs");
  assert.equal([...pol.matchAll(/"aws:SourceAccount" = data\.aws_caller_identity\.current\.account_id/g)].length, 2);
  assert.match(pol, /Principal = \{ Service = "delivery\.logs\.amazonaws\.com" \}/);
  assert.match(block(lab, "aws_s3_bucket", "nfwlogs"), /bucket\s+= local\.nfw_bucket/);
});

test("ans-27's readme names the path, the groups and Firewall Manager as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["tgw-rt-spokes", "tgw-rt-inspection", "appliance mode", "lab-ans-27-network-firewall-domains", "example.com", "alerts/", "## Not built here", "Firewall Manager"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
