// labs-aws-saa-15.test.mjs
//
// Plain English: lab saa-15-data-security is the lab AWS labs spec §12.2 row
// 15 describes: a customer key, an SSE-KMS bucket, a bucket policy, an S3
// endpoint with a policy, and an instance to test from (ruling P18).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { endpointPolicyProblem } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "saa-15-data-security";

test("saa-15 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-15's lab.yaml: §12.2 row 15, after soa-07, about £0.01/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.secure", "soa.security"], ["soa-07-iam-kms"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.003 && total < 0.015, `about £0.01/h, got ${total}`);
});

test("saa-15's key and bucket: 7-day deletion, the root's kms:*, no rotation at deploy; SSE-KMS with a Bucket Key; TLS-only and KMS-only policy", () => {
  const { tf } = awsLab(ID);
  for (const re of [/deletion_window_in_days = 7/, /Action = "kms:\*"/, /sse_algorithm\s+= "aws:kms"/, /kms_master_key_id = aws_kms_key\.data\.arn/, /bucket_key_enabled = true/, /"aws:SecureTransport" = "false"/, /StringNotEqualsIfExists = \{ "s3:x-amz-server-side-encryption" = "aws:kms" \}/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enable_key_rotation\s+= true/);
});

test("saa-15's endpoint policy allows only the lab bucket and AL2023's repositories (ruling P18); the role uses the key only via S3", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /resource "aws_vpc_endpoint_policy" "s3"/);
  assert.match(tf, /"kms:ViaService" = "s3\.\$\{var\.region\}\.amazonaws\.com"/);
  const doc = { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource: ["arn:aws:s3:::cloudlabs-a15k3x9q-data", "arn:aws:s3:::cloudlabs-a15k3x9q-data/*"] }, { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::al2023-repos-eu-west-2-*/*" }] };
  assert.equal(endpointPolicyProblem(doc, "a15k3x9q", "eu-west-2"), null);
});

test("saa-15's readme tests each layer and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["aws:kms", "--sse AES256", "aws:SourceVpce", "Disable"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
