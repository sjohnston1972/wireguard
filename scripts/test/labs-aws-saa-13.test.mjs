// labs-aws-saa-13.test.mjs
//
// Plain English: lab saa-13-decoupling is the lab AWS labs spec §12.2 row 13
// describes: SQS with a dead-letter queue, SNS fan-out to two queues, an
// EventBridge bus and rule, and Step Functions with a Lambda step, every
// reference the lab's own (ruling P14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { workflowProblem } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "saa-13-decoupling";

test("saa-13 keeps the AWS lab contract with no network", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("saa-13's lab.yaml: §12.2 row 13, after saa-12, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient"], ["saa-12-serverless-api"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.ok(yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0) < 0.01);
});

test("saa-13's messaging: a DLQ after three receives, a fan-out to two queues, each queue taking only the lab's topic, after the tag wait", () => {
  const { tf } = awsLab(ID);
  for (const re of [/maxReceiveCount = 3/, /protocol\s+= "sqs"/, /raw_message_delivery = true/, /"aws:SourceArn" = local\.topic_arn/, /Principal = \{ Service = "sns\.amazonaws\.com" \}/, /depends_on = \[time_sleep\.messaging_tags\]/, /queues\s+= toset\(\["billing", "shipping"\]\)/]) assert.match(tf, re);
});

test("saa-13's workflow names only the lab's own function and topic (ruling P14), and the bus's rule starts it", () => {
  const { tf } = awsLab(ID);
  for (const re of [/Resource\s+= "arn:aws:states:::lambda:invoke"/, /Resource\s+= "arn:aws:states:::sns:publish"/, /Catch\s+= \[\{ ErrorEquals = \["States\.ALL"\], Next = "Rejected" \}\]/, /arn\s+= aws_sfn_state_machine\.orders\.arn/, /event_bus_name = aws_cloudwatch_event_bus\.orders\.name/]) assert.match(tf, re);
  const acct = "123456789012";
  const def = { StartAt: "Validate", States: { Validate: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: `arn:aws:lambda:eu-west-2:${acct}:function:lab-${ID}-validate`, "Payload.$": "$" }, Next: "Publish" }, Publish: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: `arn:aws:sns:eu-west-2:${acct}:lab-${ID}-orders`, "Message.$": "$" }, End: true } } };
  assert.equal(workflowProblem(def, ID), null);
});

test("saa-13's readme follows an order and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lab-saa-13-decoupling-billing-dlq", "fan-out", "Rejected", "visibility timeout"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
