// labs-aws-saa-16.test.mjs
//
// Plain English: lab saa-16-dr-pilot-light is the lab AWS labs spec §12.2
// row 16 describes, the first two-region lab: S3 cross-region replication, a
// DynamoDB global table, private-zone failover on a CloudWatch-alarm health
// check, and an AMI copied to Ireland (rulings P3–P6, P19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "saa-16-dr-pilot-light";

test("saa-16 keeps the AWS lab contract; Ireland is its secondary region and it lists Route 53 in us-east-1", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
});

test("saa-16's lab.yaml: §12.2 row 16, after soa-04, two /20s, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient", "soa.reliability"], ["soa-04-backup"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 12, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.003 && total < 0.03, `pennies an hour, got ${total}`);
});

test("saa-16's Ireland: the secondary provider exactly as §4, its own resource group, VPC in the slot's second /20, nothing running", () => {
  const { files, tf } = awsLab(ID);
  assert.match(files["ireland.tf"], /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  for (const re of [/resource "aws_resourcegroups_group" "secondary" \{\n  provider = aws\.secondary/, /dr_vpc_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /image_id\s+= aws_ami_copy\.dr\.id/]) assert.match(tf, re);
  assert.doesNotMatch(files["ireland.tf"], /resource "aws_instance"|resource "aws_autoscaling_group"/, "a pilot light runs nothing in Ireland");
});

test("saa-16's data and image: replication to the Ireland bucket, a global table replica with its tags, a copy of the public AMI named for the lab", () => {
  const { tf } = awsLab(ID);
  for (const re of [/bucket\s+= aws_s3_bucket\.ireland\.arn/, /delete_marker_replication \{\n\s+status = "Enabled"/, /region_name\s+= var\.secondary_region\n\s+propagate_tags = true/, /stream_enabled\s+= true/, /name\s+= "lab-\$\{var\.lab_id\}-orders"/, /source_ami_id\s+= data\.aws_ssm_parameter\.al2023_arm64\.insecure_value/, /name\s+= "lab-\$\{var\.lab_id\}-al2023-\$\{var\.name_prefix\}"/]) assert.match(tf, re);
});

test("saa-16's failover: a private .internal zone in both lab VPCs, a CloudWatch-metric health check on the lab's alarm, PRIMARY and SECONDARY records", () => {
  const { tf } = awsLab(ID);
  for (const re of [/name\s+= "dr\.\$\{var\.name_prefix\}\.internal"/, /vpc_id\s+= aws_vpc\.lab\.id/, /vpc_id\s+= aws_vpc\.dr\.id/, /type\s+= "CLOUDWATCH_METRIC"/, /cloudwatch_alarm_name\s+= aws_cloudwatch_metric_alarm\.app_down\.alarm_name/, /treat_missing_data\s+= "breaching"/, /type = "PRIMARY"/, /type = "SECONDARY"/, /records\s+= \[local\.dr_ip\]/]) assert.match(tf, re);
});

test("saa-16's readme runs a DR drill and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["pilot light", "eice-dr", "COMPLETED", "global table", "fallback"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
