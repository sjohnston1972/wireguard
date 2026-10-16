// labs-aws-soa-08.test.mjs
//
// Plain English: lab soa-08-vpc-fix is the break-fix lab AWS labs spec §12.2
// row 08 describes, with exactly its three faults (ruling A28): no route back
// in the data VPC, no outbound ephemeral rule in the database subnet's ACL,
// and MySQL admitted from the wrong /24.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-08-vpc-fix";

test("soa-08 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-08's lab.yaml: §12.2 row 08", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "break-fix", ["soa.networking", "soa.monitoring", "ans.operations"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 4, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.008 && total < 0.02, `about £0.01/h, got ${total}`);
});

test("fault 1: rt-data has no route back to the app VPC, while rt-private has one to the data VPC", () => {
  const { lab, tf } = awsLab(ID);
  const routes = resources(lab, "aws_route");
  assert.deepEqual(routes.map((r) => r.labels[1]), ["app_to_data"]);
  assert.match(routes[0].body, /route_table_id\s+= aws_route_table\.private\.id/);
  assert.doesNotMatch(resources(lab, "aws_route_table").find((r) => r.labels[1] === "data").body, /route\s*\{/);
  assert.match(tf, /# FAULT 1/);
});

test("fault 2: acl-db has no outbound rule for ephemeral ports", () => {
  const { lab } = awsLab(ID);
  const rules = resources(lab, "aws_network_acl_rule").map((r) => r.body);
  const out = rules.filter((b) => /egress\s+= true/.test(b));
  assert.equal(out.length, 1);
  assert.match(out[0], /from_port\s+= 443/);
  assert.ok(!out.some((b) => /from_port\s+= 1024/.test(b)));
  assert.ok(rules.some((b) => /egress\s+= false/.test(b) && /from_port\s+= 3306/.test(b)));
});

test("fault 3: sg-db admits 3306 from the app VPC's second /24, not vm-web's", () => {
  const { lab, tf } = awsLab(ID);
  const mysql = resources(lab, "aws_vpc_security_group_ingress_rule").find((r) => r.labels[1] === "db_mysql").body;
  assert.match(mysql, /cidr_ipv4\s+= local\.wrong_cidr/);
  assert.match(tf, /wrong_cidr = cidrsubnet\(local\.vpc_cidr, 4, 1\)/);
  assert.match(resources(lab, "aws_instance").find((r) => r.labels[1] === "web").body, /subnet_id\s+= aws_subnet\.private\[0\]\.id/);
});

test("soa-08's second Instance Connect Endpoint sits in vm-db's subnet (ruling P17); both VPCs have flow logs to the lab's group", () => {
  const { lab } = awsLab(ID);
  assert.match(resources(lab, "aws_ec2_instance_connect_endpoint").find((r) => r.labels[1] === "data").body, /subnet_id\s+= aws_subnet\.db\.id/);
  const flows = resources(lab, "aws_flow_log");
  assert.deepEqual(flows.map((r) => r.labels[1]).sort(), ["app", "data"]);
  for (const f of flows) assert.match(f.body, /log_destination\s+= aws_cloudwatch_log_group\.flow\.arn/);
});

test("soa-08's readme: Symptom, a closed What was broken naming the three faults, and the Reachability Analyzer charge", () => {
  const { readme } = awsLab(ID);
  assert.match(readme, /## Symptom/);
  assert.match(readme, /<details>\n<summary>What was broken<\/summary>/);
  for (const s of ["sg-db", "acl-db", "rt-data", "pcx-app-data", "7.5p"]) assert.ok(readme.includes(s), s);
});

test("soa-08's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
