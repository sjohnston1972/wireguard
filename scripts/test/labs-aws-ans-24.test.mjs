// labs-aws-ans-24.test.mjs
//
// Plain English: lab ans-24-privatelink is the lab AWS labs spec §12.2 row 24
// describes: a provider VPC with an NLB and an endpoint service, a consumer
// VPC with an interface endpoint and a private name, and a gateway endpoint
// with a policy (rulings A88, A100, P1, P13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-24-privatelink";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-24 keeps the AWS lab contract and lists its private zone in us-east-1 (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
});

test("ans-24's lab.yaml: §12.2 row 24, about £0.04/h, the NLB and the endpoint billed by the whole hour, one role", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation", "ans.security", "saa.secure"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  assert.deepEqual(yaml.regions, { secondary: null });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.035 && total < 0.055, `about £0.04/h, got ${total}`);
  for (const n of ["Network Load Balancer, hourly", "Interface endpoint, one Availability Zone"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("ans-24's endpoint service (ruling P13): an internal NLB, this account's root only, accepted at once, no private DNS name", () => {
  const { tf } = awsLab(ID);
  for (const re of [/internal\s+= true/, /load_balancer_type\s+= "network"/, /preserve_client_ip = "false"/, /acceptance_required\s+= false/, /network_load_balancer_arns = \[aws_lb\.provider\.arn\]/, /allowed_principals\s+= \["arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root"\]/, /target_id\s+= aws_instance\.provider\.id/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /private_dns_name|supported_regions|gateway_load_balancer_arns/);
});

test("ans-24's consumer: an interface endpoint to the lab's own service in one subnet, a private .internal alias to it, no route to the provider", () => {
  const { tf } = awsLab(ID);
  const e = block("aws_vpc_endpoint", "svc");
  for (const re of [/service_name\s+= aws_vpc_endpoint_service\.lab\.service_name/, /vpc_endpoint_type\s+= "Interface"/, /subnet_ids\s+= \[aws_subnet\.private\[0\]\.id\]/, /private_dns_enabled = false/]) assert.match(e, re);
  for (const re of [/svc_domain\s+= "svc\.\$\{var\.name_prefix\}\.internal"/, /name\s+= aws_vpc_endpoint\.svc\.dns_entry\[0\]\.dns_name/, /provider_cidr = cidrsubnet\(var\.address_space, 2, 1\)/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /aws_vpc_peering_connection|resource "aws_route" /, "PrivateLink needs no peering and no routes");
});

test("ans-24's S3 (ruling A100): the gateway endpoint's policy and the role reach only the lab's bucket", () => {
  const { tf } = awsLab(ID);
  for (const re of [/vpc_endpoint_id = aws_vpc_endpoint\.s3\.id/, /Resource = \[local\.data_arn, "\$\{local\.data_arn\}\/\*"\]/, /arn:aws:s3:::al2023-repos-\$\{var\.region\}-\*\/\*/, /Action = "s3:ListBucket", Resource = local\.data_arn/, /Action = "s3:GetObject", Resource = "\$\{local\.data_arn\}\/\*"/, /iam_instance_profile\s+= aws_iam_instance_profile\.consumer\.name/]) assert.match(tf, re);
});

test("ans-24's readme shows both names, the provider's view and the endpoint policy; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["vpces-lab", "vpce-svc", "app.svc.", "journalctl -u lab-web", "no peering", "hello.txt"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
