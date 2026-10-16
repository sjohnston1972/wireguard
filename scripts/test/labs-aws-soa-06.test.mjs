// labs-aws-soa-06.test.mjs
//
// Plain English: lab soa-06-cloudformation is the lab AWS labs spec §12.2
// row 06 describes, built to the §4 contract, and its CloudFormation template
// passes the lint and the plan's template rule (ruling P4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { CFN_TYPES, cfnTemplateProblems } from "../../infra/ci/lab-scope-aws.mjs";
import { lintCfnText } from "../../infra/ci/lab-lint.mjs";

const ID = "soa-06-cloudformation";

test("soa-06 keeps the AWS lab contract (no network.tf: it cannot peer, ruling P3)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("soa-06's lab.yaml: §12.2 row 06", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.deployment"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 4, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0 && total < 0.01, `under a penny an hour (tier £), got ${total}`);
});

test("soa-06's template: only CFN_TYPES, long-form functions, names from the stack, and the template rule passes it (ruling P4)", () => {
  const { tfDir, tf } = awsLab(ID);
  const text = readFileSync(join(tfDir, "cfn", "stack.yaml"), "utf8");
  assert.deepEqual(lintCfnText({ "cfn/stack.yaml": text }), []);
  const doc = parseYaml(text);
  assert.deepEqual(Object.values(doc.Resources).map((r) => r.Type).sort(), ["AWS::CloudWatch::Alarm", "AWS::Logs::LogGroup", "AWS::SNS::Topic", "AWS::SQS::Queue", "AWS::SQS::Queue", "AWS::SSM::Parameter"]);
  for (const r of Object.values(doc.Resources)) assert.ok(CFN_TYPES.has(r.Type));
  const parameters = { LabId: ID, VisibilityTimeout: "30", MaxReceiveCount: "3", LogGroupName: `/cloudlabs/${ID}/stack`, ParameterName: `/cloudlabs/${ID}/config/greeting` };
  assert.deepEqual(cfnTemplateProblems(JSON.parse(JSON.stringify(doc)), { labId: ID, parameters }), []);
  // stack.tf passes these values (the test above checked the template with them).
  assert.match(tf, /LogGroupName\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/stack"/);
  assert.match(tf, /ParameterName\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/config\/greeting"/);
  assert.match(tf, /VisibilityTimeout = "30"/);
  assert.match(tf, /MaxReceiveCount\s+= "3"/);
  assert.match(tf, /template_body = jsonencode\(yamldecode\(file\("\$\{path\.module\}\/cfn\/stack\.yaml"\)\)\)/);
  assert.match(tf, /iam_role_arn\s+= aws_iam_role\.cfn\.arn/);
  assert.match(tf, /Principal = \{ Service = "cloudformation\.amazonaws\.com" \}/);
  assert.match(tf, /Action = \["Update:Replace", "Update:Delete"\], Principal = "\*", Resource = "LogicalResourceId\/WorkQueue"/);
});

test("soa-06's readme names what it builds and explains StackSets", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-06-cloudformation-stack", "lab-soa-06-cloudformation-cfn", "/cloudlabs/soa-06-cloudformation/config/greeting", "## Not built here", "StackSets", "Ref: VisibilityTimeout"]) assert.ok(readme.includes(s), s);
});

test("soa-06's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
