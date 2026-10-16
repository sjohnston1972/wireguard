// labs-aws-saa-19.test.mjs
//
// Plain English: lab saa-19-eks is the lab AWS labs spec §12.2 row 19
// describes: an EKS cluster with a one-node managed group (t4g.medium), a NAT
// gateway and a sample deployment reached by port-forward, with no way to
// leave a load balancer behind (rulings P7, P8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_MEDIUM_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "saa-19-eks";
const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");

test("saa-19 keeps the AWS lab contract; its public subnets are soa-03's and its NAT gateway soa-10's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
  assert.equal(body(`${ID}/terraform/nat.tf`), body("soa-10-containers/terraform/nat.tf"));
});

test("saa-19's lab.yaml: §12.2 row 19, expert, after soa-10, about £0.14/h with the NAT gateway by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "expert", "explore", ["saa.performance"], ["soa-10-containers"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.capacity.instance_types, ["t4g.medium", "t4g.medium"]);
  assert.ok(AWS_MEDIUM_LABS.includes(ID));
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.12 && total < 0.17, `about £0.14/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
});

test("Review Focus 3: saa-19's cluster role cannot make a load balancer, and nobody is admin until given an entry (ruling P7)", () => {
  const { tf } = awsLab(ID);
  for (const re of [/Action = \["elasticloadbalancing:CreateLoadBalancer", "ec2:CreateSecurityGroup"\]/, /Effect = "Deny"/, /policy_arn = aws_iam_policy\.no_load_balancers\.arn/, /authentication_mode\s+= "API"/, /bootstrap_cluster_creator_admin_permissions = false/, /support_type = "STANDARD"/, /endpoint_public_access\s+= true/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enabled_cluster_log_types|aws_eks_access_entry|provider "kubernetes"/);
});

test("saa-19's node group: one t4g.medium (max 2), AL2023 for arm64, a launch template that tags at launch and keeps IMDSv2 a hop from pods", () => {
  const { tf } = awsLab(ID);
  for (const re of [/instance_types\s+= \["t4g\.medium"\]/, /desired_size = 1/, /max_size\s+= 2/, /ami_type\s+= "AL2023_ARM_64_STANDARD"/, /http_put_response_hop_limit = 2/, /volume_size\s+= 20/]) assert.match(tf, re);
});

test("saa-19's readme gives access, deploys by kubectl, uses port-forward, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["access entry", "aws-auth", "port-forward", "stays pending", "root user"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
