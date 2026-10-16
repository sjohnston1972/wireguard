// labs-aws-saa-18.test.mjs
//
// Plain English: lab saa-18-cost-compute is the lab AWS labs spec §12.2 row
// 18 describes: a mixed-instances group with an On-Demand base and Spot
// above it, t4g and t3, and a price comparison in the readme (ruling P9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-18-cost-compute";

test("saa-18 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-18's lab.yaml: §12.2 row 18, after soa-03, about £0.02/h, one capacity entry per instance at the group's maximum", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.cost", "saa.performance"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.capacity.instance_types, ["t4g.micro", "t4g.micro", "t4g.small", "t3.micro"]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.01 && total < 0.03, `about £0.015/h, got ${total}`);
});

test("saa-18's group: an On-Demand base of 1, Spot above it, price-capacity-optimized, rebalancing, never waiting for capacity (ruling P9)", () => {
  const { tf } = awsLab(ID);
  for (const re of [/on_demand_base_capacity\s+= 1/, /on_demand_percentage_above_base_capacity = 0/, /spot_allocation_strategy\s+= "price-capacity-optimized"/, /capacity_rebalance\s+= true/, /wait_for_capacity_timeout = "0"/, /max_size\s+= 4/, /propagate_at_launch = true/]) assert.match(tf, re);
});

test("saa-18's templates: Graviton and x86 from AWS's public parameters, t3.micro only through the x86 template", () => {
  const { tf } = awsLab(ID);
  for (const re of [/name = "\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-x86_64"/, /instance_type = "t3\.micro"\n\s+launch_template_specification \{\n\s+launch_template_id = aws_launch_template\.mixed\["x86"\]\.id/, /instance-life-cycle/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /spot-instances-request/, "Spot requests are never tagged (ruling P9)");
});

test("saa-18's page is written by a script, so systemd never sees the shell variables (pre-flight C7)", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /ExecStartPre=\/usr\/local\/bin\/lab-page/);
  assert.doesNotMatch(tf, /ExecStartPre=[^\n]*\$T/);
});

test("saa-18's readme compares prices, explains commitments, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["`t3.micro`, Intel (x86_64)", "capacity rebalancing", "## Not built here", "Savings Plans and Reserved Instances"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
