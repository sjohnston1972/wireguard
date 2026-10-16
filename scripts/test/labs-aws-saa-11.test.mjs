// labs-aws-saa-11.test.mjs
//
// Plain English: lab saa-11-three-tier is the lab AWS labs spec §12.2 row 11
// describes: an ALB, an Auto Scaling group of 2, RDS MySQL Multi-AZ and an
// ElastiCache node behind a NAT gateway, each tier in its own subnets
// (rulings P16, P17).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-11-three-tier";
const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");

test("saa-11 keeps the AWS lab contract; its public subnets and ALB are soa-03's, its NAT gateway soa-10's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
  assert.equal(body(`${ID}/terraform/alb.tf`), body("soa-03-auto-scaling/terraform/alb.tf"));
  assert.equal(body(`${ID}/terraform/nat.tf`), body("soa-10-containers/terraform/nat.tf"));
});

test("saa-11's lab.yaml: §12.2 row 11, about £0.13/h with the NAT gateway and the ALB billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient", "saa.performance"], ["soa-03-auto-scaling", "soa-05-rds"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.11 && total < 0.15, `about £0.13/h, got ${total}`);
  for (const n of ["NAT gateway, hourly", "Application Load Balancer, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("saa-11's data tier: private Multi-AZ MySQL, one Valkey node, no route out, each admitting only the app tier", () => {
  const { tf } = awsLab(ID);
  for (const re of [/multi_az\s+= true/, /publicly_accessible\s+= false/, /instance_class\s+= "db\.t4g\.micro"/, /engine\s+= "valkey"/, /node_type\s+= "cache\.t4g\.micro"/, /num_cache_clusters\s+= 1/, /at_rest_encryption_enabled = true/, /snapshot_retention_limit\s+= 0/, /skip_final_snapshot\s+= true/, /cidrsubnet\(local\.vpc_cidr, 4, 2 \+ count\.index\)/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /final_snapshot_identifier/);
  const data = body(`${ID}/terraform/data.tf`);
  assert.doesNotMatch(data, /aws_route"/, "rt-data has no route out");
  assert.equal([...data.matchAll(/referenced_security_group_id = aws_security_group\.vms\.id/g)].length, 2);
});

test("saa-11's app tier: 2 to 4 t4g.micro behind the ALB, started after the data tier and the NAT route", () => {
  const { tf } = awsLab(ID);
  for (const re of [/min_size\s+= 2/, /max_size\s+= 4/, /desired_capacity\s+= 2/, /target_group_arns\s+= \[aws_lb_target_group\.web\.arn\]/, /depends_on = \[aws_vpc_endpoint\.s3, aws_lb_listener\.http, aws_route\.private_nat\]/, /aws_db_instance\.app\.address/, /aws_elasticache_replication_group\.app\.primary_endpoint_address/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("saa-11's readme names each tier and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["snet-data-1/2", "db-app", "cache-app", "alb-web", "Reboot with failover"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
