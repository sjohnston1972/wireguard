// labs-aws-saa-14.test.mjs
//
// Plain English: lab saa-14-storage is the lab AWS labs spec §12.2 row 14
// describes: a bucket with Intelligent-Tiering and lifecycle, EFS with mount
// targets, and gp3 and io2 volumes on one instance, inside rule size's caps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-14-storage";

test("saa-14 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-14's lab.yaml: §12.2 row 14, about £0.02/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.performance", "saa.cost"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.012 && total < 0.03, `about £0.02/h, got ${total}`);
});

test("saa-14's volumes: a gp3 and an io2 of 4 GiB, the io2 at 100 IOPS (under rule size's 500), untagged by name so nothing cycles", () => {
  const { tf } = awsLab(ID);
  for (const re of [/type\s+= "gp3"/, /type\s+= "io2"/, /iops\s+= 100/, /device_name\s+= "\/dev\/sdf"/, /device_name\s+= "\/dev\/sdg"/, /stop_instance_before_detaching = true/, /volume_tags\s+= var\.tags/]) assert.match(tf, re);
  for (const m of tf.matchAll(/resource "aws_ebs_volume" "\w+" \{[\s\S]*?\n\}/g)) assert.doesNotMatch(m[0], /tags\s+=/, "volumes carry only default tags (ruling A49)");
});

test("saa-14's EFS: encrypted, bursting, two mount targets after the tag wait, NFS only from the lab instances; mounted at boot; no lifecycle policy at deploy (ruling P11)", () => {
  const { tf } = awsLab(ID);
  for (const re of [/encrypted\s+= true/, /throughput_mode\s+= "bursting"/, /count\s+= 2\n\s+file_system_id/, /depends_on\s+= \[time_sleep\.efs_tags\]/, /from_port\s+= 2049/, /amazon-efs-utils/, /\/mnt\/efs efs _netdev,tls/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /lifecycle_policy/, "a lifecycle policy is a tag-checked change straight after the create");
});

test("saa-14's bucket: Intelligent-Tiering with archive tiers, a logs/ lifecycle, force_destroy; readme and learning content", () => {
  const { tf, readme, learning, yaml } = awsLab(ID);
  for (const re of [/access_tier = "ARCHIVE_ACCESS"/, /storage_class = "INTELLIGENT_TIERING"/, /storage_class = "GLACIER_IR"/, /force_destroy = true/]) assert.match(tf, re);
  for (const s of ["gp3", "io2", "efs-shared", "INTELLIGENT_TIERING", "xfs_growfs"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
