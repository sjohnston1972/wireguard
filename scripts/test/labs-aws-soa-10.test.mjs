// labs-aws-soa-10.test.mjs
//
// Plain English: lab soa-10-containers is the lab AWS labs spec §12.2 row 10
// describes: ECR, an ECS cluster with Container Insights, two Fargate tasks
// behind an ALB, and a NAT gateway (ruling P16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-10-containers";

test("soa-10 keeps the AWS lab contract; its public subnets are soa-03's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
});

test("soa-10's lab.yaml: §12.2 row 10, about £0.10/h with the NAT gateway and the ALB billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.deployment", "soa.monitoring"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 6, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.08 && total < 0.12, `about £0.10/h (tier £), got ${total}`);
  for (const n of ["NAT gateway, hourly", "Application Load Balancer, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("soa-10's ECS: Container Insights, Fargate ARM64 at 0.25 vCPU, two tasks with no public IP, tags from the service, logs to the lab's group", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /name\s+= "containerInsights"\n\s+value = "enabled"/, /cpu_architecture\s+= "ARM64"/, /cpu\s+= "256"/, /desired_count\s+= 2/,
    /assign_public_ip = false/, /propagate_tags\s+= "SERVICE"/, /"awslogs-group" = local\.log_group/, /log_group = "\/cloudlabs\/\$\{var\.lab_id\}\/web"/,
    /image\s+= "public\.ecr\.aws\/nginx\/nginx:stable-alpine"/, /target_type\s+= "ip"/, /policy_arn = "arn:aws:iam::aws:policy\/service-role\/AmazonECSTaskExecutionRolePolicy"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /awslogs-create-group/);
  assert.doesNotMatch(tf, /aws_ecs_cluster_capacity_providers|aws_appautoscaling_/, "ruling P16");
});

test("soa-10's ECR and NAT: force_delete, scan on push, a lifecycle policy after the tag wait; one NAT gateway in a public subnet", () => {
  const { tf } = awsLab(ID);
  for (const re of [/force_delete\s+= true/, /scan_on_push = true/, /depends_on = \[time_sleep\.ecr_tags\]/, /subnet_id\s+= aws_subnet\.public\[0\]\.id/, /nat_gateway_id\s+= aws_nat_gateway\.lab\.id/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("soa-10's readme names what it builds and explains EKS", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-10-containers-web", "nat-lab", "Container Insights", "## Not built here", "Amazon EKS"]) assert.ok(readme.includes(s), s);
});

test("soa-10's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
