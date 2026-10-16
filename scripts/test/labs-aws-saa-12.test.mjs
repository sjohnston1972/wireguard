// labs-aws-saa-12.test.mjs
//
// Plain English: lab saa-12-serverless-api is the lab AWS labs spec §12.2 row
// 12 describes: an HTTP API with a JWT authoriser on the lab's Cognito pool,
// a Lambda function and a DynamoDB table on demand (rulings P12, P13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-12-serverless-api";

test("saa-12 keeps the AWS lab contract with no network (it cannot peer; ruling A61)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { files } = awsLab(ID);
  assert.equal(files["network.tf"], undefined);
});

test("saa-12's lab.yaml: §12.2 row 12, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.secure", "saa.resilient", "saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity.creates, ["role"]);
  assert.ok(yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0) < 0.01);
});

test("saa-12's API: JWT on the lab's own pool and client for /items, /health open, throttled, a Lambda proxy", () => {
  const { tf } = awsLab(ID);
  for (const re of [/protocol_type = "HTTP"/, /authorizer_type\s+= "JWT"/, /audience = \[aws_cognito_user_pool_client\.cli\.id\]/, /issuer\s+= "https:\/\/\$\{aws_cognito_user_pool\.users\.endpoint\}"/, /integration_type\s+= "AWS_PROXY"/, /throttling_burst_limit = 10/, /throttling_rate_limit\s+= 5/, /source_arn\s+= "\$\{aws_apigatewayv2_api\.lab\.execution_arn\}\/\*\/\*"/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/authorization_type = "JWT"/g)].length, 2, "GET and POST /items");
  assert.doesNotMatch(tf, /aws_cognito_user_pool_domain|body\s+=/);
});

test("saa-12's pool, table and function: Lite, protection off, admin-made users; on demand, named for the lab; tag waits", () => {
  const { tf } = awsLab(ID);
  for (const re of [/user_pool_tier\s+= "LITE"/, /deletion_protection = "INACTIVE"/, /allow_admin_create_user_only = true/, /password\s+= var\.admin_password/, /message_action = "SUPPRESS"/, /billing_mode\s+= "PAY_PER_REQUEST"/, /name\s+= "lab-\$\{var\.lab_id\}-items"/, /log_group\s+= aws_cloudwatch_log_group\.api\.name/, /depends_on\s+= \[time_sleep\.pool_tags\]/, /depends_on\s+= \[time_sleep\.function_tags\]/]) assert.match(tf, re);
});

test("saa-12's readme shows signing in and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["labuser", "JWT authoriser", "401", "429", "cognito:username"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
