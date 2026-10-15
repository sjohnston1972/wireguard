// labs-aws-soa-05.test.mjs
//
// Plain English: lab soa-05-rds is AWS labs spec §12.2 row 05, built to the
// §4 contract, with every RDS setting a tear-down needs (§7.3 rule 12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-05-rds";

test("soa-05 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-05's lab.yaml: §12.2 row 05", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "soa.monitoring", "saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 30, destroy_min: 20, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano"] });
  assert.deepEqual(yaml.identity.creates, []);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.06, `about £0.05/h, got ${total}`);
});

test("both databases are removable and small (rules 12 and 13), MySQL 8.4, Performance Insights off (A34)", () => {
  const { tf } = awsLab(ID);
  for (const db of ["primary", "replica"]) {
    const block = tf.slice(tf.indexOf(`resource "aws_db_instance" "${db}"`), tf.indexOf("\n}\n", tf.indexOf(`resource "aws_db_instance" "${db}"`)));
    for (const re of [/skip_final_snapshot\s+= true/, /deletion_protection\s+= false/, /delete_automated_backups\s+= true/, /copy_tags_to_snapshot\s+= true/, /instance_class\s+= "db\.t4g\.micro"/, /performance_insights_enabled = false/, /publicly_accessible\s+= false/]) assert.match(block, re, `${db}: ${re}`);
  }
  assert.match(tf, /engine_version\s+= "8\.4"/);
  assert.match(tf, /family = "mysql8\.4"/);
  assert.match(tf, /multi_az\s+= true/);
  assert.match(tf, /replicate_source_db\s+= aws_db_instance\.primary\.identifier/);
  assert.doesNotMatch(tf, /enabled_cloudwatch_logs_exports|max_allocated_storage/);
});

test("soa-05's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
