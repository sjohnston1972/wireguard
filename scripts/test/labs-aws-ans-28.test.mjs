// labs-aws-ans-28.test.mjs
//
// Plain English: lab ans-28-flow-logs-fix is the break-fix lab AWS labs spec
// §12.2 row 28 describes, with exactly its two faults (ruling A28): the
// targets' security group admits only the NLB subnets while client IP
// preservation delivers client addresses, and the service subnet's ACL drops
// the replies to the client range. Flow logs go to CloudWatch and to S3 with
// an Athena table; a mirror target and filter wait for a session made by
// hand (rulings P8, P17).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-28-flow-logs-fix";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-28 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-28's lab.yaml: §12.2 row 28, a break-fix after soa-08, two /20s, a role, about 4p/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "break-fix", ["ans.operations", "ans.security", "soa.networking"], ["soa-08-vpc-fix"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.03 && total < 0.05, `about £0.04/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "Network Load Balancer, hourly").whole_hours, true);
});

test("fault 1: sg-svc admits TCP 80 only from snet-nlb, while the target group keeps client IP preservation on", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_lb_target_group", "svc"), /preserve_client_ip = "true"/);
  assert.match(block(lab, "aws_lb", "svc"), /internal\s+= true/);
  assert.doesNotMatch(block(lab, "aws_lb", "svc"), /security_groups/);
  const http = resources(lab, "aws_vpc_security_group_ingress_rule").filter((r) => /security_group_id\s+= aws_security_group\.svc\.id/.test(r.body) && /from_port\s+= 80/.test(r.body));
  assert.deepEqual(http.map((r) => r.labels[1]), ["svc_http"]);
  assert.match(http[0].body, /cidr_ipv4\s+= local\.nlb_cidr/);
  assert.match(tf, /nlb_cidr\s+= cidrsubnet\(local\.svc_vpc_cidr, 4, 0\)/);
  assert.equal([...tf.matchAll(/# FAULT 1/g)].length, 2);
});

test("fault 2: acl-svc on snet-svc denies everything out to vpc-lab at rule 90, before rule 100 allows everything", () => {
  const { lab, tf } = awsLab(ID);
  const rules = resources(lab, "aws_network_acl_rule").map((r) => r.body);
  const deny = rules.filter((b) => /rule_action\s+= "deny"/.test(b));
  assert.equal(deny.length, 1);
  for (const re of [/rule_number\s+= 90/, /egress\s+= true/, /cidr_block\s+= local\.vpc_cidr/, /protocol\s+= "-1"/]) assert.match(deny[0], re);
  assert.ok(rules.some((b) => /egress\s+= true/.test(b) && /rule_number\s+= 100/.test(b) && /rule_action\s+= "allow"/.test(b)));
  assert.ok(rules.some((b) => /egress\s+= false/.test(b) && /rule_action\s+= "allow"/.test(b)));
  assert.match(block(lab, "aws_network_acl_association", "svc"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(tf, /# FAULT 2/);
});

test("ruling A75: the service VPC's Instance Connect Endpoint sits in snet-svc beside vm-svc; the client VPC is the hub", () => {
  const { lab, files } = awsLab(ID);
  assert.match(block(lab, "aws_ec2_instance_connect_endpoint", "service"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(block(lab, "aws_instance", "svc"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(files["outputs.tf"], /output "peer_route_table_ids" \{\n  value = \[aws_route_table\.private\.id\]/);
});

test("ruling P8: flow logs to the lab's group through the lab's role and to the lab's bucket in hourly Hive folders, the bucket's policy naming this account", () => {
  const { lab } = awsLab(ID);
  assert.deepEqual(resources(lab, "aws_flow_log").map((r) => r.labels[1]).sort(), ["service", "service_s3"]);
  const cw = block(lab, "aws_flow_log", "service");
  for (const re of [/log_destination\s+= aws_cloudwatch_log_group\.flow\.arn/, /iam_role_arn\s+= aws_iam_role\.flowlogs\.arn/, /vpc_id\s+= aws_vpc\.service\.id/]) assert.match(cw, re);
  const s3 = block(lab, "aws_flow_log", "service_s3");
  for (const re of [/log_destination_type\s+= "s3"/, /log_destination\s+= aws_s3_bucket\.flowlogs\.arn/, /file_format\s+= "plain-text"/, /hive_compatible_partitions = true/, /per_hour_partition\s+= true/, /depends_on = \[aws_s3_bucket_policy\.flowlogs\]/]) assert.match(s3, re);
  const pol = block(lab, "aws_s3_bucket_policy", "flowlogs");
  assert.equal([...pol.matchAll(/"aws:SourceAccount" = local\.account/g)].length, 2);
  assert.match(pol, /Resource\s+= "\$\{local\.flowlogs_arn\}\/\$\{local\.flowlogs_s3_root\}\/\*"/);
  assert.match(block(lab, "aws_iam_role", "flowlogs"), /"aws:SourceAccount" = local\.account/);
  assert.match(block(lab, "aws_cloudwatch_log_group", "flow"), /retention_in_days = 1/);
});

test("ruling A97: the Athena table in lab_<id> over the bucket's AWSLogs/, seven projected partitions, a workgroup capped at 10 MB", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(tf, /glue_db = "lab_\$\{replace\(var\.lab_id, "-", "_"\)\}"/);
  const t = block(lab, "aws_glue_catalog_table", "flow");
  for (const re of [/database_name = aws_glue_catalog_database\.flow\.name/, /location\s+= "s3:\/\/\$\{aws_s3_bucket\.flowlogs\.bucket\}\/AWSLogs\/"/, /"projection\.enabled"\s+= "true"/, /"skip\.header\.line\.count"\s+= "1"/]) assert.match(t, re);
  assert.deepEqual([...t.matchAll(/partition_keys \{\n\s+name = "([^"]+)"/g)].map((m) => m[1]), ["aws-account-id", "aws-service", "aws-region", "year", "month", "day", "hour"]);
  assert.equal([...t.matchAll(/columns \{/g)].length, 14);
  const wg = block(lab, "aws_athena_workgroup", "flow");
  for (const re of [/force_destroy = true/, /bytes_scanned_cutoff_per_query\s+= 10485760/, /enforce_workgroup_configuration\s+= true/, /output_location = "s3:\/\/\$\{aws_s3_bucket\.flowlogs\.bucket\}\/athena\/"/]) assert.match(wg, re);
});

test("ruling P17: the mirror target is vm-monitor's own interface, the filter keeps TCP 80 inside the slot both ways, and no session is built", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_ec2_traffic_mirror_target", "monitor"), /network_interface_id = aws_instance\.monitor\.primary_network_interface_id/);
  const rules = resources(lab, "aws_ec2_traffic_mirror_filter_rule");
  assert.deepEqual(rules.map((r) => r.labels[1]).sort(), ["in", "out"]);
  for (const r of rules) for (const re of [/protocol\s+= 6/, /source_cidr_block\s+= var\.address_space/, /destination_cidr_block\s+= var\.address_space/, /from_port = 80/, /rule_action\s+= "accept"/]) assert.match(r.body, re, r.labels[1]);
  assert.doesNotMatch(tf, /resource "aws_ec2_traffic_mirror_session"/);
  assert.match(block(lab, "aws_vpc_security_group_ingress_rule", "monitor_vxlan"), /from_port\s+= 4789/);
});

test("ans-28's readme: Symptom, a closed What was broken naming both faults, the per-use charges, and valid learning content", () => {
  const { readme, learning, yaml } = awsLab(ID);
  assert.match(readme, /## Symptom/);
  assert.match(readme, /<details>\n<summary>What was broken<\/summary>/);
  for (const s of ["sg-svc", "acl-svc", "client IP preservation", "rule 90", "REJECT", "vpc_flow_logs", "lab-ans-28-flow-logs-fix-wg", "7.5p", "per network interface", "Athena charges", "create-traffic-mirror-session"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
