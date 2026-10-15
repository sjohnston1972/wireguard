// labs-aws-soa-02.test.mjs
//
// Plain English: lab soa-02-systems-manager is AWS labs spec §12.2 row 02,
// built to the §4 contract, and the only lab with a Config recorder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_CONFIG_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "soa-02-systems-manager";

test("soa-02 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-02's lab.yaml: §12.2 row 02", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.monitoring", "soa.deployment", "soa.security"], ["soa-01-cloudwatch"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 4, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.micro"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.035 && total < 0.05, `about £0.04-0.05/h, got ${total}`);
  assert.ok(AWS_CONFIG_LABS.includes(ID));
});

test("soa-02 builds the SSM pieces and the Config rule with automatic remediation", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /for_each\s+=\s+toset\(\["ssm", "ssmmessages", "ec2messages"\]\)/,
    /operating_system\s+=\s+"AMAZON_LINUX_2023"/, /patch_group\s+=\s+"lab-\$\{var\.lab_id\}-web"/,
    /name\s+=\s+"AWS-RunPatchBaseline"/, /name\s+=\s+"AWS-GatherSoftwareInventory"/,
    /name\s+=\s+"lab-\$\{var\.lab_id\}-recorder"/, /resource_types\s+=\s+\["AWS::EC2::SecurityGroup", "AWS::EC2::Instance"\]/,
    /source_identifier\s+=\s+"INCOMING_SSH_DISABLED"/, /target_id\s+=\s+"AWS-DisablePublicAccessForSecurityGroup"/, /automatic\s+=\s+true/,
    /resource "aws_security_group" "demo"/, /force_destroy\s+=\s+true/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /cidr_ipv4\s+=\s+"0\.0\.0\.0\/0"[\s\S]{0,80}from_port\s+=\s+22/, "the lab never opens SSH itself");
});

test("soa-02's Config rule is scoped to this lab's security groups, so remediation never touches others (preflight C17)", () => {
  const { lab } = awsLab(ID);
  const rule = lab.blocks.find((b) => b.kind === "resource" && b.labels[0] === "aws_config_config_rule" && b.labels[1] === "restricted_ssh");
  assert.ok(rule, "the restricted_ssh rule exists");
  assert.match(rule.body, /tag_key\s+=\s+"cloudlabs-lab"/);
  assert.match(rule.body, /tag_value\s+=\s+var\.lab_id/);
  // AWS Config refuses a scope with both resource types and a tag (release test 2026-10-15, InvalidParameterValueException):
  // the tag alone, and the managed rule judges security groups only.
  assert.doesNotMatch(rule.body, /compliance_resource_types/);
  assert.match(rule.body, /source_identifier\s+=\s+"INCOMING_SSH_DISABLED"/);
});

test("soa-02's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
