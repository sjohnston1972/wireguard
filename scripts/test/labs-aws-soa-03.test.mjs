// labs-aws-soa-03.test.mjs
//
// Plain English: lab soa-03-auto-scaling is the AWS labs spec's own example
// (§3.2) and §12.2 row 03, built to the §4 contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-03-auto-scaling";

test("soa-03 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-03's lab.yaml is §3.2's example (identity.creates [] by ruling A33)", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "soa.deployment", "saa.resilient"], ["soa-01-cloudwatch"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.micro", "t4g.micro", "t4g.micro"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.cost.items.map((i) => [i.name, i.gbp_h, i.qty ?? 1, !!i.whole_hours]), [
    ["EC2 t4g.micro, Linux (2 running)", 0.0071, 2, false],
    ["EBS gp3 root volume, 8 GiB", 0.0008, 2, false],
    ["Application Load Balancer, hourly", 0.0199, 1, true],
    ["ALB capacity units, light test traffic", 0.006, 1, false],
    ["Public IPv4 addresses on the ALB (2 AZs)", 0.0038, 2, false],
    ["EC2 Instance Connect Endpoint", 0, 1, false],
  ]);
});

test("soa-03 builds the group, template, ALB and its scaling settings; no IAM", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /min_size\s+= 2\n\s+max_size\s+= 4/, /health_check_type\s+= "ELB"/, /predefined_metric_type = "ASGAverageCPUUtilization"/,
    /recurrence\s+= "0 22 \* \* \*"/, /lifecycle_transition\s+= "autoscaling:EC2_INSTANCE_LAUNCHING"/, /strategy = "Rolling"/,
    /load_balancer_type\s+= "application"/, /enable_deletion_protection = false/, /internal\s+= false/,
    /key\s+= "cloudlabs-lab"\n\s+value\s+= var\.lab_id\n\s+propagate_at_launch = true/, /map_public_ip_on_launch = false/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /resource "aws_iam_/);
});

test("soa-03's launched instances carry the session's tags (default_tags do not reach ASG-launched resources)", () => {
  const { tf } = awsLab(ID);
  for (const type of ["instance", "volume"]) {
    assert.match(tf, new RegExp(`tag_specifications \\{\\n\\s+resource_type = "${type}"\\n\\s+tags\\s+= merge\\(var\\.tags, \\{ Name = "vm-web" \\}\\)`), `${type} tags come from var.tags`);
  }
  assert.match(tf, /http_tokens\s+= "required"/);
  assert.doesNotMatch(tf, /associate_public_ip_address\s+= true/);
});

test("soa-03's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
