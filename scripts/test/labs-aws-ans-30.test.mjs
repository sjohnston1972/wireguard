// labs-aws-ans-30.test.mjs
//
// Plain English: lab ans-30-vpc-lattice is the lab AWS labs spec §12.2 row 30
// describes: a Lattice service network requiring signed requests, two
// services with instance targets in two VPCs, IAM auth policies, and a
// client signing with SigV4 (rulings P7, P19, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-30-vpc-lattice";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-30 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-30's lab.yaml: §12.2 row 30, after ans-24, about £0.05/h, one role", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security"], ["ans-24-privatelink"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 8, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.06, `about £0.05/h, got ${total}`);
  const s = yaml.cost.items.find((i) => i.name.startsWith("VPC Lattice services"));
  assert.deepEqual([s.gbp_h, s.qty, s.aws_price], [0.0188, 2, undefined]);
});

test("ans-30's Lattice (ruling P19): a signing-only network, two signing-only services, instance targets in two VPCs, only vpc-lab associated", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/auth_type = "AWS_IAM"/g)].length, 3);
  assert.equal([...tf.matchAll(/type = "INSTANCE"/g)].length, 2);
  assert.match(block("aws_vpclattice_target_group", "a"), /vpc_identifier = aws_vpc\.lab\.id/);
  assert.match(block("aws_vpclattice_target_group", "b"), /vpc_identifier = aws_vpc\.svc_b\.id/);
  assert.match(block("aws_vpclattice_target_group_attachment", "a"), /id\s+= aws_instance\.svc_a\.id/);
  assert.match(block("aws_vpclattice_target_group_attachment", "b"), /id\s+= aws_instance\.svc_b\.id/);
  assert.match(block("aws_vpclattice_service_network_vpc_association", "lab"), /vpc_identifier\s+= aws_vpc\.lab\.id[\s\S]*security_group_ids\s+= \[aws_security_group\.lattice\.id\]/);
  assert.equal([...tf.matchAll(/resource "aws_vpclattice_service_network_vpc_association"/g)].length, 1);
  assert.match(tf, /svc_b_cidr = cidrsubnet\(var\.address_space, 2, 1\)/);
  assert.doesNotMatch(tf, /aws_vpc_peering_connection|resource "aws_route" /, "Lattice needs no peering and no routes");
});

test("ans-30's auth policies (rulings P7, P19): known at plan, the lab's client role only, GET only on svc-a, none on svc-b", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /client_role_arn = "arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:role\/cloudlabs-lab\/lab-\$\{var\.lab_id\}-client"/);
  assert.match(block("aws_vpclattice_auth_policy", "network"), /resource_identifier = aws_vpclattice_service_network\.lab\.arn[\s\S]*Principal = \{ AWS = local\.client_role_arn \}/);
  assert.match(block("aws_vpclattice_auth_policy", "svc_a"), /resource_identifier = aws_vpclattice_service\.a\.arn[\s\S]*"vpc-lattice-svcs:RequestMethod" = "GET"/);
  assert.equal([...tf.matchAll(/resource "aws_vpclattice_auth_policy"/g)].length, 2, "svc-b has no auth policy");
  assert.doesNotMatch(tf, /aws_iam_role\.client\.arn/, "the policies are known at plan");
  assert.match(block("aws_iam_policy", "invoke"), /Action\s+= "vpc-lattice-svcs:Invoke"/);
});

test("ans-30's waits and targets (rulings P21, A45): changes after 20 seconds; targets admit HTTP only from Lattice's prefix list", () => {
  const { tf } = awsLab(ID);
  assert.match(block("time_sleep", "lattice_tags"), /create_duration = "20s"/);
  for (const [t, n] of [["aws_vpclattice_target_group_attachment", "a"], ["aws_vpclattice_target_group_attachment", "b"], ["aws_vpclattice_auth_policy", "network"], ["aws_vpclattice_auth_policy", "svc_a"]]) assert.match(block(t, n), /depends_on\s+= \[time_sleep\.lattice_tags/, `${t}.${n}`);
  assert.match(tf, /name = "com\.amazonaws\.\$\{var\.region\}\.vpc-lattice"/);
  assert.equal([...tf.matchAll(/prefix_list_id\s+= data\.aws_ec2_managed_prefix_list\.lattice\.id/g)].length, 2);
});

test("ans-30's client signs with SigV4 for vpc-lattice-svcs, the payload unsigned", () => {
  const { files } = awsLab(ID);
  for (const s of ["--aws-sigv4 'aws:amz:${var.region}:vpc-lattice-svcs'", "x-amz-content-sha256: UNSIGNED-PAYLOAD", "x-amz-security-token", "/usr/local/bin/lattice-curl", "X-aws-ec2-metadata-token-ttl-seconds"]) assert.ok(files["compute.tf"].includes(s), s);
  assert.match(block("aws_instance", "client"), /iam_instance_profile\s+= aws_iam_instance_profile\.client\.name/);
});

test("ans-30's readme signs, is refused, and fixes svc-b by hand; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lattice-curl", "--aws-sigv4", "403", "GET only", "no auth policy", "com.amazonaws.eu-west-2.vpc-lattice"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
