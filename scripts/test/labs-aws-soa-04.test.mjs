// labs-aws-soa-04.test.mjs
//
// Plain English: lab soa-04-backup is AWS labs spec §12.2 row 04, built to
// the §4 contract, and leaves nothing a tear-down cannot remove.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-04-backup";

test("soa-04 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-04's lab.yaml: §12.2 row 04", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "saa.resilient"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total < 0.01, `about £0.005/h (tier £), got ${total}`);
});

test("soa-04 makes everything removable: vault and buckets force-destroyed, recovery points tagged, no vault lock or object lock", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /resource "aws_backup_vault" "lab" \{\n\s+name\s+= "lab-\$\{var\.lab_id\}-vault"\n\s+force_destroy = true/,
    /recovery_point_tags = var\.tags/, /key\s+= "aws:ResourceTag\/cloudlabs-lab"\n\s+value = var\.lab_id/,
    /bucket\s+= local\.src_bucket\n\s+force_destroy = true/, /bucket\s+= local\.dst_bucket\n\s+force_destroy = true/,
    /delete_marker_replication \{\n\s+status = "Enabled"/, /storage_class = "STANDARD_IA"/, /"cloudlabs-backup" = "daily"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /object_lock|vault_lock/);
  // Policy documents name the buckets by ARNs known at plan (A42), never aws_s3_bucket.<x>.arn.
  assert.match(tf, /Resource = local\.src_arn/);
  assert.match(tf, /Resource = "\$\{local\.dst_arn\}\/\*"/);
});

test("soa-04 tags the root volume through root_block_device, not volume_tags (C18)", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /root_block_device \{[^}]*\n\s+tags\s+= merge\(var\.tags, \{ Name = "vm-data" \}\)/);
  assert.doesNotMatch(tf, /volume_tags/);
});

test("soa-04's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
