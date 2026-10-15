// labs-aws-soa-01.test.mjs
//
// Plain English: lab soa-01-cloudwatch is the lab AWS labs spec §12.2 row 01
// describes, built to the §4 contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-01-cloudwatch";

test("soa-01 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-01's lab.yaml: §12.2 row 01", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "foundation", "explore", ["soa.monitoring"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro"] });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.025 && total < 0.035, `about £0.03/h (tier £), got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name.startsWith("Interface VPC endpoints")).whole_hours, true);
});

test("soa-01 builds the agent, filter, alarms, dashboard, query, rule and endpoints the readme names", () => {
  const { tf, readme } = awsLab(ID);
  for (const re of [
    /resource "aws_cloudwatch_log_group" "app"[\s\S]*?retention_in_days = 1/,
    /resource "aws_cloudwatch_log_metric_filter" "errors"[\s\S]*?pattern\s+= "ERROR"/,
    /resource "aws_cloudwatch_metric_alarm" "cpu_high"/, /resource "aws_cloudwatch_metric_alarm" "app_errors"/, /resource "aws_cloudwatch_metric_alarm" "memory_high"/,
    /dashboard_name = "lab-\$\{var\.lab_id\}-overview"/, /resource "aws_cloudwatch_query_definition" "errors"/,
    /resource "aws_cloudwatch_event_rule" "state"/, /resource "aws_sns_topic" "alerts"/,
    /for_each\s+= toset\(\["logs", "monitoring"\]\)/, /policy_arn = "arn:aws:iam::aws:policy\/CloudWatchAgentServerPolicy"/, /monitoring\s+= true/,
  ]) assert.match(tf, re);
  for (const name of ["vm-app", "lab-soa-01-cloudwatch-alerts", "lab-soa-01-cloudwatch-overview", "lab-errors", "/cloudlabs/soa-01-cloudwatch/app"]) assert.ok(readme.includes(name), name);
});

test("soa-01's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
