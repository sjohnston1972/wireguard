// labs-aws-soa-07.test.mjs
//
// Plain English: lab soa-07-iam-kms is the lab AWS labs spec §12.2 row 07
// describes: the one AWS lab with an IAM user, held by the boundary, whose
// Terraform-generated password reaches the dashboard only through the sensitive users
// output (ruling P5); a key whose policy keeps it deletable; a secret its own
// function rotates; and the account's analyzer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_IAM_USER_LABS, validateLearning } from "../lib/labs.mjs";
import { ACCESS_ANALYZER_LABS } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "soa-07-iam-kms";

test("soa-07 keeps the AWS lab contract (no network.tf, ruling P3)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-07's lab.yaml: §12.2 row 07; the one lab with a user and an analyzer", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.security", "saa.secure"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.identity, { creates: ["role", "user"], roles: [], governance: false });
  assert.deepEqual([AWS_IAM_USER_LABS, ACCESS_ANALYZER_LABS], [[ID], [ID]]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.001 && total < 0.01, `about £0.0014/h, got ${total}`);
});

test("soa-07's user: boundary, force_destroy, no forced reset, and the password only in the sensitive users output (rulings P5, P6)", () => {
  const { tf, files } = awsLab(ID);
  assert.match(tf, /resource "aws_iam_user" "ann" \{[\s\S]*?permissions_boundary = local\.boundary_arn[\s\S]*?force_destroy\s+= true/);
  assert.match(tf, /password_reset_required = false/);
  assert.match(files["outputs.tf"], /output "users" \{\n\s+sensitive = true/);
  const passwordUses = [...tf.matchAll(/aws_iam_user_login_profile\.ann\.password/g)].length;
  assert.equal(passwordUses, 1, "the password appears only in the users output");
  assert.doesNotMatch(files["outputs.tf"].split('output "connect"')[1], /password\}/);
});

test("soa-07's key, secret and rotation: 7-day window, root grant, no recovery window, own function, own log group, waits for tags (ruling P15)", () => {
  const { tf, tfDir } = awsLab(ID);
  for (const re of [
    /deletion_window_in_days = 7/, /Principal = \{ AWS = "arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root" \}, Action = "kms:\*"/,
    /recovery_window_in_days = 0/, /kms_key_id\s+= aws_kms_key\.data\.arn/,
    /log_group\s+= aws_cloudwatch_log_group\.rotate\.name/, /name\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/rotate"/,
    /principal\s+= "secretsmanager\.amazonaws\.com"/, /resource "time_sleep" "tags" \{\n\s+create_duration = "20s"/,
    /type\s+= "ACCOUNT"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enable_key_rotation\s+= true/, "rotation is switched on by hand (ruling P15)");
  const py = readFileSync(join(tfDir, "lambda", "rotate.py"), "utf8");
  for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"]) assert.ok(py.includes(`"${step}"`), step);
});

test("soa-07's readme names what it builds and explains SCPs", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-07-iam-kms-ann", "alias/lab-soa-07-iam-kms-data", "lab-soa-07-iam-kms-rotate", "lab-soa-07-iam-kms-account", "## Not built here", "service control policies"]) assert.ok(readme.includes(s), s);
});

test("soa-07's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
