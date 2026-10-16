// labs-aws-saa-17.test.mjs
//
// Plain English: lab saa-17-data-pipeline is the lab AWS labs spec §12.2 row
// 17 describes: one Kinesis shard, a producer Lambda on a schedule, Firehose
// to S3, a Glue crawler and an Athena workgroup (rulings P13–P15).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-17-data-pipeline";

test("saa-17 keeps the AWS lab contract with no network", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("saa-17's lab.yaml: §12.2 row 17, about £0.01–0.02/h, the shard hour priced", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.01 && total < 0.03, `about £0.013/h, got ${total}`);
});

test("saa-17's stream and producer: one provisioned shard deleted with its consumers, a producer every minute allowed only by its own rule", () => {
  const { tf } = awsLab(ID);
  for (const re of [/shard_count\s+= 1/, /stream_mode = "PROVISIONED"/, /enforce_consumer_deletion = true/, /schedule_expression = "rate\(1 minute\)"/, /source_arn\s+= aws_cloudwatch_event_rule\.every_minute\.arn/, /depends_on\s+= \[time_sleep\.producer_tags\]/, /log_group\s+= aws_cloudwatch_log_group\.producer\.name/]) assert.match(tf, re);
});

test("saa-17's delivery and catalogue: Firehose from the stream to the lake with its logging off; an unscheduled crawler on the lake; a capped workgroup", () => {
  const { tf } = awsLab(ID);
  for (const re of [/destination = "extended_s3"/, /kinesis_stream_arn = aws_kinesis_stream\.events\.arn/, /cloudwatch_logging_options \{\n\s+enabled = false/, /glue_db\s+= "lab_\$\{replace\(var\.lab_id, "-", "_"\)\}"/, /path = "s3:\/\/\$\{aws_s3_bucket\.lake\.bucket\}\/events\/"/, /bytes_scanned_cutoff_per_query\s+= 10485760/, /enforce_workgroup_configuration\s+= true/, /force_destroy = true/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /schedule\s+= "cron/);
  assert.doesNotMatch(tf, /"logs:/, "the crawler role makes no log group (ruling P15)");
});

test("saa-17's readme names the per-use charges and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["about 5p a run", "10 MB", "lab_saa_17_data_pipeline", "update-shard-count"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
