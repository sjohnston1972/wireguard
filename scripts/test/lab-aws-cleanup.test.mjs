// lab-aws-cleanup.test.mjs
//
// Plain English: the AWS clean-up steps (AWS labs spec §8) against a pretend
// AWS CLI (fixtures/labs/harness.mjs records every call): Unblock turns off
// what stops a delete, the safety net deletes everything tagged or named for
// the lab in dependency order with no Terraform state at all, and Verify
// clean judges each candidate by its real state, naming untagged leftovers
// inside the lab's VPCs. Skipped without bash and jq (CI has both).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASH, fwd, JQ, REPO, world } from "./fixtures/labs/harness.mjs";

const skip = BASH && JQ ? false : "needs bash and jq (CI has both)";
const ID = "soa-03-auto-scaling";
const A = (r) => `arn:aws:ec2:eu-west-2:123456789012:${r}`;
const tagged = (...arns) => JSON.stringify({ ResourceTagMappingList: arns.map((x) => ({ ResourceARN: x, Tags: [{ Key: "cloudlabs-lab", Value: ID }] })) });
const ENV = { LAB_REGIONS: "eu-west-2", LAB_DELETE_POLL_SECONDS: "0", LAB_UNBLOCK_VAULT_WAIT_SECONDS: "0", LAB_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 3600) };
const EMPTY_IAM = [
  { cmd: "aws", match: "^iam list-roles", out: '{"Roles":[]}' },
  { cmd: "aws", match: "^iam list-instance-profiles", out: '{"InstanceProfiles":[]}' },
  { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
  { cmd: "aws", match: "^iam list-users", out: '{"Users":[]}' },
];

for (const f of ["lab-unblock-aws.sh", "lab-aws-safety-net.sh"]) {
  test(`${f} passes bash -n and refuses a bad id before calling AWS`, { skip }, () => {
    assert.equal(spawnSync(BASH, ["-n", fwd(join(REPO, "infra", "ci", f))], { encoding: "utf8" }).status, 0);
    const w = world([]);
    assert.equal(w.run(`infra/ci/${f}`, ["bad id"], ENV).status, 2);
    assert.equal(w.calls().filter((c) => c.startsWith("aws")).length, 0);
    w.cleanup();
  });
}

test("safety net with no state deletes the tagged instance, then its security group, subnet and VPC, in that order", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("vpc/vpc-0a"), A("subnet/subnet-0b"), A("security-group/sg-0c"), A("instance/i-0d")) },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0d", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0d","State":{"Name":"terminated"}}]}]}' },
    { cmd: "aws", match: "^ec2 describe-security-groups", out: '{"SecurityGroups":[{"GroupId":"sg-0c","GroupName":"lab-vms","VpcId":"vpc-0a","IpPermissions":[],"IpPermissionsEgress":[]}]}' },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (terminate|delete)/.test(c));
  const at = (re) => writes.findIndex((c) => re.test(c));
  assert.ok(at(/terminate-instances --instance-ids i-0d/) >= 0);
  assert.ok(at(/terminate-instances/) < at(/delete-security-group --group-id sg-0c/));
  assert.ok(at(/delete-security-group/) < at(/delete-subnet --subnet-id subnet-0b/));
  assert.ok(at(/delete-subnet/) < at(/delete-vpc --vpc-id vpc-0a/));
  w.cleanup();
});

test("safety net deletes only this lab's IAM, by path and prefix, profiles before roles, never another lab's or the pipeline's", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^iam list-roles", out: JSON.stringify({ Roles: [{ RoleName: `lab-${ID}-web`, Path: "/cloudlabs-lab/" }, { RoleName: "lab-soa-04-backup-backup", Path: "/cloudlabs-lab/" }, { RoleName: "wg-admin-labs", Path: "/cloudlabs-lab/" }] }) },
    { cmd: "aws", match: "^iam list-instance-profiles", out: JSON.stringify({ InstanceProfiles: [{ InstanceProfileName: `lab-${ID}-web`, Roles: [{ RoleName: `lab-${ID}-web` }] }] }) },
    { cmd: "aws", match: "^iam list-attached-role-policies", out: '{"AttachedPolicies":[{"PolicyArn":"arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"}]}' },
    { cmd: "aws", match: "^iam list-role-policies", out: '{"PolicyNames":[]}' },
    { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
    { cmd: "aws", match: "^iam list-users", out: '{"Users":[]}' },
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const iam = w.calls().filter((c) => /^aws iam (delete|remove|detach)/.test(c));
  assert.deepEqual(iam, [
    `aws iam remove-role-from-instance-profile --instance-profile-name lab-${ID}-web --role-name lab-${ID}-web`,
    `aws iam delete-instance-profile --instance-profile-name lab-${ID}-web`,
    `aws iam detach-role-policy --role-name lab-${ID}-web --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`,
    `aws iam delete-role --role-name lab-${ID}-web`,
  ]);
  w.cleanup();
});

test("Verify clean: a tagging-API ghost (terminated) counts clean and writes the outputs", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("instance/i-0dead")) },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0dead", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0dead","State":{"Name":"terminated"}}]}]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(out, "utf8"), /^clean=true\nleftovers=\[\]$/m);
  assert.equal(w.calls().filter((c) => /^aws \S+ (delete|terminate)/.test(c)).length, 0, "verify never deletes");
  w.cleanup();
});

test("Verify clean: an untagged instance in a lab VPC is a named leftover (A26), and the run is dirty", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("vpc/vpc-0a")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0a", out: '{"Vpcs":[{"VpcId":"vpc-0a","Tags":[{"Key":"cloudlabs-lab","Value":"soa-03-auto-scaling"},{"Key":"Name","Value":"vpc-lab"}]}]}' },
    { cmd: "aws", match: "^ec2 describe-instances --filters Name=vpc-id,Values=vpc-0a", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0hand","State":{"Name":"running"},"Tags":[{"Key":"Name","Value":"my-test"}]}]}]}' },
    { cmd: "aws", match: "^ec2 describe-network-interfaces --filters Name=vpc-id,Values=vpc-0a", out: '{"NetworkInterfaces":[]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.ok(left.includes("ec2:vpc vpc-0a (vpc-lab)"), JSON.stringify(left));
  assert.ok(left.includes("untagged inside lab VPC: i-0hand (my-test)"), JSON.stringify(left));
  assert.doesNotMatch(readFileSync(out, "utf8"), /123456789012/);
  w.cleanup();
});

test("Verify clean: a tagged type with no handler yet is a leftover, never clean (P6)", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:sagemaker:eu-west-2:123456789012:notebook-instance/lab-x") },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  assert.match(readFileSync(out, "utf8"), /no handler for sagemaker:notebook-instance: lab-x/);
  w.cleanup();
});

test("Verify clean: a listing AWS refuses makes the run dirty with a reason", { skip }, () => {
  const w = world([{ cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: "", code: 254, err: "An error occurred (AccessDeniedException)" }, ...EMPTY_IAM]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  assert.match(readFileSync(out, "utf8"), /could not list tagged resources in eu-west-2/);
  w.cleanup();
});

test("Unblock turns off deletion protection, stops the Config recorder, empties the vault, and never fails", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q", "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/alb-a03k3x9q/1", A("instance/i-0d"), "arn:aws:backup:eu-west-2:123456789012:backup-vault:lab-soa-03-auto-scaling-vault") },
    { cmd: "aws", match: "^configservice describe-configuration-recorders", out: `{"ConfigurationRecorders":[{"name":"lab-${ID}-recorder"},{"name":"default"}]}` },
    { cmd: "aws", match: "^backup list-recovery-points-by-backup-vault", out: ['{"RecoveryPoints":[{"RecoveryPointArn":"arn:aws:ec2:eu-west-2::snapshot/snap-1"}]}', '{"RecoveryPoints":[]}'] },
    { cmd: "aws", match: "^rds modify-db-instance", out: "", code: 254, err: "InvalidDBInstanceState" },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  for (const re of [/^aws rds modify-db-instance --db-instance-identifier db-a05k3x9q --no-deletion-protection --apply-immediately/, /^aws elbv2 modify-load-balancer-attributes .*Key=deletion_protection\.enabled,Value=false/, /^aws ec2 modify-instance-attribute --instance-id i-0d --no-disable-api-termination/, /^aws ec2 modify-instance-attribute --instance-id i-0d --no-disable-api-stop/, new RegExp(`^aws configservice stop-configuration-recorder --configuration-recorder-name lab-${ID}-recorder`), /^aws backup delete-recovery-point --backup-vault-name lab-soa-03-auto-scaling-vault --recovery-point-arn arn:aws:ec2:eu-west-2::snapshot\/snap-1/]) assert.ok(calls.some((c) => re.test(c)), String(re));
  assert.ok(!calls.some((c) => /stop-configuration-recorder --configuration-recorder-name default/.test(c)), "never another recorder");
  assert.match(r.out, /::warning::/);
  w.cleanup();
});

// ── Beyond the plan's tests ─────────────────────────────────────────────

// The VPN server is never the safety net's: not an item carrying wg-admin (even with the lab's tag), not
// anything inside the server's VPC (found by its wg-admin = vpn tag).
test("safety net never touches the VPN server: an item tagged wg-admin=vpn, or inside its VPC, is skipped even with the lab tag", { skip }, () => {
  const both = JSON.stringify({ ResourceTagMappingList: [
    { ResourceARN: A("vpc/vpc-0wg"), Tags: [{ Key: "cloudlabs-lab", Value: ID }, { Key: "wg-admin", Value: "vpn" }, { Key: "Name", Value: "vpc-wg" }] },
    { ResourceARN: A("instance/i-0wg"), Tags: [{ Key: "cloudlabs-lab", Value: ID }, { Key: "wg-admin", Value: "vpn" }] },
    { ResourceARN: A("subnet/subnet-0inwg"), Tags: [{ Key: "cloudlabs-lab", Value: ID }] },
    { ResourceARN: A("security-group/sg-0inwg"), Tags: [{ Key: "cloudlabs-lab", Value: ID }] },
    { ResourceARN: A("subnet/subnet-0lab"), Tags: [{ Key: "cloudlabs-lab", Value: ID }] },
    { ResourceARN: A("vpc/vpc-0lab"), Tags: [{ Key: "cloudlabs-lab", Value: ID }] },
  ] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: both },
    { cmd: "aws", match: "^ec2 describe-vpcs --filters Name=tag:wg-admin,Values=vpn", out: '{"Vpcs":[{"VpcId":"vpc-0wg"}]}' },
    { cmd: "aws", match: "^ec2 describe-subnets --subnet-ids subnet-0inwg", out: '{"Subnets":[{"SubnetId":"subnet-0inwg","VpcId":"vpc-0wg"}]}' },
    { cmd: "aws", match: "^ec2 describe-subnets --subnet-ids subnet-0lab", out: '{"Subnets":[{"SubnetId":"subnet-0lab","VpcId":"vpc-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-security-groups --group-ids sg-0inwg", out: '{"SecurityGroups":[{"GroupId":"sg-0inwg","GroupName":"lab-x","VpcId":"vpc-0wg","IpPermissions":[],"IpPermissionsEgress":[]}]}' },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (?!describe)/.test(c));
  for (const id of ["vpc-0wg", "i-0wg", "subnet-0inwg", "sg-0inwg"]) assert.ok(!writes.some((c) => c.includes(id)), `${id} untouched: ${writes.join(" | ")}`);
  assert.ok(writes.some((c) => /delete-subnet --subnet-id subnet-0lab/.test(c)));
  assert.ok(writes.some((c) => /delete-vpc --vpc-id vpc-0lab/.test(c)));
  assert.match(r.out, /::warning::.*vpc-0wg.*VPN server/);
  assert.match(r.out, /::warning::.*subnet-0inwg.*VPN server/);
  // Unreadable: the server's VPC could not be found, so nothing VPC-bound in that region is deleted.
  const blind = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("subnet/subnet-0lab")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --filters Name=tag:wg-admin,Values=vpn", out: "", code: 254, err: "An error occurred (RequestLimitExceeded) when calling the DescribeVpcs operation: 123456789012" },
    ...EMPTY_IAM,
  ]);
  const b = blind.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(b.status, 0, b.out);
  assert.ok(!blind.calls().some((c) => /delete-subnet/.test(c)));
  assert.doesNotMatch(b.out, /123456789012/, "AWS's error text is never printed");
  w.cleanup();
  blind.cleanup();
});

test("Unblock never touches an item carrying the VPN server's wg-admin tag, even with the lab's tag", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: JSON.stringify({ ResourceTagMappingList: [
      { ResourceARN: A("instance/i-0wg"), Tags: [{ Key: "cloudlabs-lab", Value: ID }, { Key: "wg-admin", Value: "vpn" }] },
      { ResourceARN: A("instance/i-0lab"), Tags: [{ Key: "cloudlabs-lab", Value: ID }] },
    ] }) },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  assert.ok(!w.calls().some((c) => c.includes("i-0wg")), "the server's instance is never modified");
  assert.ok(w.calls().some((c) => /modify-instance-attribute --instance-id i-0lab --no-disable-api-termination/.test(c)));
  assert.match(r.out, /::warning::.*i-0wg.*VPN server/);
  w.cleanup();
});

test("Verify clean judges each candidate by its real state: deleted, delete-complete and not-found are clean; the rest are named", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("natgateway/nat-0a"), A("instance-connect-endpoint/eice-0b"), A("instance/i-0live"), "arn:aws:s3:::cloudlabs-a03k3x9q-logs", "arn:aws:rds:eu-west-2:123456789012:db:db-a03k3x9q", "arn:aws:logs:eu-west-2:123456789012:log-group:/lab/soa-03", A("vpc-endpoint/vpce-0c")) },
    { cmd: "aws", match: "^ec2 describe-nat-gateways --nat-gateway-ids nat-0a", out: '{"NatGateways":[{"NatGatewayId":"nat-0a","State":"deleted"}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints --instance-connect-endpoint-ids eice-0b", out: '{"InstanceConnectEndpoints":[{"State":"delete-complete"}]}' },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0live", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0live","State":{"Name":"running"},"Tags":[{"Key":"Name","Value":"vm-web"}]}]}]}' },
    { cmd: "aws", match: "^s3api head-bucket --bucket cloudlabs-a03k3x9q-logs", code: 254, err: "An error occurred (404) when calling the HeadBucket operation: Not Found" },
    { cmd: "aws", match: "^rds describe-db-instances --db-instance-identifier db-a03k3x9q", code: 254, err: "An error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation: DBInstance db-a03k3x9q not found." },
    { cmd: "aws", match: "^logs describe-log-groups --log-group-name-prefix /lab/soa-03", out: '{"logGroups":[{"logGroupName":"/lab/soa-03-other"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-endpoints --vpc-endpoint-ids vpce-0c", code: 254, err: "An error occurred (UnauthorizedOperation) when calling the DescribeVpcEndpoints operation: account 123456789012" },
    { cmd: "aws", match: "^iam list-roles", out: JSON.stringify({ Roles: [{ RoleName: `lab-${ID}-web`, Path: "/cloudlabs-lab/" }] }) },
    { cmd: "aws", match: "^iam get-role --role-name", out: `{"Role":{"RoleName":"lab-${ID}-web"}}` },
    ...EMPTY_IAM.slice(1),
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1, r.out);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["ec2:instance i-0live (vm-web)", "ec2:vpc-endpoint vpce-0c (could not read its state)", `iam:role lab-${ID}-web`].sort());
  assert.match(readFileSync(out, "utf8"), /^clean=false$/m);
  assert.doesNotMatch(r.out + readFileSync(out, "utf8"), /123456789012/);
  w.cleanup();
});

// Review round 1: an answer Verify cannot read is never clean.
test("Verify clean: head-bucket answering with no body means the bucket is there; an unparseable describe is never clean", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:s3:::cloudlabs-a03k3x9q-logs", A("instance/i-0odd"), A("natgateway/nat-0gone")) },
    { cmd: "aws", match: "^s3api head-bucket --bucket cloudlabs-a03k3x9q-logs", out: "" },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0odd", out: "<html>Service Unavailable" },
    { cmd: "aws", match: "^ec2 describe-nat-gateways --nat-gateway-ids nat-0gone", out: '{"NatGateways":[]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1, r.out);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["ec2:instance i-0odd (could not read its state)", "s3:bucket cloudlabs-a03k3x9q-logs"], "a parsed empty list (nat-0gone) is still gone");
  w.cleanup();
});

test("safety net waits for an RDS instance already being deleted before deleting its subnet and parameter groups", { skip }, () => {
  const deleting = '{"DBInstances":[{"DBInstanceIdentifier":"db-a05k3x9q","DBInstanceStatus":"deleting"}]}';
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q", "arn:aws:rds:eu-west-2:123456789012:subgrp:lab-subnets", "arn:aws:rds:eu-west-2:123456789012:pg:lab-params") },
    { cmd: "aws", match: "^rds describe-db-instances --db-instance-identifier db-a05k3x9q", out: [deleting, deleting, deleting, ""], code: [0, 0, 0, 254], err: ["", "", "", "An error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation: DBInstance db-a05k3x9q not found."] },
    { cmd: "aws", match: "^rds delete-db-instance", out: "", code: 254, err: "An error occurred (InvalidDBInstanceState) when calling the DeleteDBInstance operation: Instance db-a05k3x9q is already being deleted." },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const describes = calls.map((c, k) => (/^aws rds describe-db-instances/.test(c) ? k : -1)).filter((k) => k >= 0);
  assert.equal(describes.length, 4, "polled until DBInstanceNotFound");
  const sub = calls.findIndex((c) => /^aws rds delete-db-subnet-group --db-subnet-group-name lab-subnets/.test(c));
  const pg = calls.findIndex((c) => /^aws rds delete-db-parameter-group --db-parameter-group-name lab-params/.test(c));
  assert.ok(sub > describes.at(-1) && pg > sub, calls.join("\n"));
  assert.doesNotMatch(r.out, /::warning::.*InvalidDBInstanceState/, "already deleting is not a refusal");
  w.cleanup();
  // Still "modifying" after Unblock: the delete is refused, then asked again once the instance is free.
  const modifying = '{"DBInstances":[{"DBInstanceIdentifier":"db-a05k3x9q","DBInstanceStatus":"modifying"}]}';
  const busy = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q") },
    { cmd: "aws", match: "^rds describe-db-instances --db-instance-identifier db-a05k3x9q", out: [modifying, modifying, modifying, deleting, ""], code: [0, 0, 0, 0, 254], err: ["", "", "", "", "An error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation: not found"] },
    { cmd: "aws", match: "^rds delete-db-instance", out: ["", ""], code: [254, 0], err: ["An error occurred (InvalidDBInstanceState) when calling the DeleteDBInstance operation: modifying", ""] },
    ...EMPTY_IAM,
  ]);
  const b = busy.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(b.status, 0, b.out);
  assert.equal(busy.calls().filter((c) => /^aws rds delete-db-instance --db-instance-identifier db-a05k3x9q/.test(c)).length, 2, busy.calls().join("\n"));
  assert.doesNotMatch(b.out, /left behind/);
  busy.cleanup();
});

test("safety net warns when it cannot read the Config rules to find a rule's name", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:config:eu-west-2:123456789012:config-rule/config-rule-abc123") },
    { cmd: "aws", match: "^configservice describe-config-rules", out: "", code: 254, err: "An error occurred (AccessDeniedException) when calling the DescribeConfigRules operation: 123456789012" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::.*could not read config:config-rule config-rule-abc123 .*\(AccessDeniedException\)/);
  assert.ok(!w.calls().some((c) => /delete-config-rule/.test(c)));
  assert.doesNotMatch(r.out, /123456789012/);
  w.cleanup();
});

test("a delete still running at the deadline is left behind (a warning), the sweep goes on and exits 0", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("instance/i-0slow"), A("vpc/vpc-0a")) },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0slow", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0slow","State":{"Name":"shutting-down"}}]}]}' },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], { ...ENV, LAB_JOB_DEADLINE: String(Math.floor(Date.now() / 1000)) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::.*left behind: ec2:instance i-0slow/);
  assert.ok(w.calls().some((c) => /^aws ec2 delete-vpc --vpc-id vpc-0a/.test(c)), "the sweep carries on");
  w.cleanup();
});

test("safety net empties a bucket of every version and delete marker before deleting it, and stops asking when AWS keeps them", { skip }, () => {
  const page = '{"Versions":[{"Key":"a.txt","VersionId":"v1","Size":1}],"DeleteMarkers":[{"Key":"b.txt","VersionId":"v2"}]}';
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:s3:::cloudlabs-a03k3x9q-logs", "arn:aws:s3:::cloudlabs-a03k3x9q-locked") },
    { cmd: "aws", match: "^s3api list-object-versions --bucket cloudlabs-a03k3x9q-logs", out: [page, '{"Versions":[],"DeleteMarkers":[]}'] },
    { cmd: "aws", match: "^s3api list-object-versions --bucket cloudlabs-a03k3x9q-locked", out: page },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls().filter((c) => /^aws s3api (delete|list)/.test(c));
  const logs = calls.filter((c) => c.includes("-logs"));
  assert.match(logs[1], /^aws s3api delete-objects --bucket cloudlabs-a03k3x9q-logs --delete file:\/\/\S+ --region eu-west-2$/);
  assert.match(logs.at(-1), /^aws s3api delete-bucket --bucket cloudlabs-a03k3x9q-logs --region eu-west-2$/);
  assert.equal(logs.filter((c) => c.includes("delete-objects")).length, 1);
  // The locked bucket answers the same versions again: one delete-objects, a warning, then the (failing) bucket delete.
  assert.equal(calls.filter((c) => c.includes("delete-objects --bucket cloudlabs-a03k3x9q-locked")).length, 1);
  assert.match(r.out, /::warning::.*s3:bucket cloudlabs-a03k3x9q-locked still holds 2 object version\(s\)/);
  w.cleanup();
});

test("safety net clears the lab's named Config recorder and channel, dashboards and queries, and warns on a type it has no handler for", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:sagemaker:eu-west-2:123456789012:notebook-instance/lab-x", "arn:aws:events:eu-west-2:123456789012:rule/lab-soa-03-auto-scaling-stop", "arn:aws:autoscaling:eu-west-2:123456789012:autoScalingGroup:0f1e2d3c-aaaa-bbbb-cccc-000000000000:autoScalingGroupName/asg-a03k3x9q") },
    { cmd: "aws", match: "^configservice describe-configuration-recorders", out: `{"ConfigurationRecorders":[{"name":"lab-${ID}-recorder"},{"name":"default"}]}` },
    { cmd: "aws", match: "^configservice describe-delivery-channels", out: `{"DeliveryChannels":[{"name":"lab-${ID}-channel"},{"name":"default"}]}` },
    { cmd: "aws", match: "^cloudwatch list-dashboards", out: `{"DashboardEntries":[{"DashboardName":"lab-${ID}-ops"}]}` },
    { cmd: "aws", match: "^logs describe-query-definitions", out: `{"queryDefinitions":[{"queryDefinitionId":"qd-1","name":"lab-${ID}-errors"}]}` },
    { cmd: "aws", match: "^events list-targets-by-rule", out: '{"Targets":[{"Id":"sns"}]}' },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const at = (re) => calls.findIndex((c) => re.test(c));
  assert.ok(at(/^aws autoscaling delete-auto-scaling-group --auto-scaling-group-name asg-a03k3x9q --force-delete/) >= 0);
  assert.ok(at(/^aws events remove-targets --rule lab-soa-03-auto-scaling-stop --ids sns/) >= 0);
  assert.ok(at(/^aws events remove-targets/) < at(/^aws events delete-rule --name lab-soa-03-auto-scaling-stop/));
  assert.ok(at(new RegExp(`^aws configservice stop-configuration-recorder --configuration-recorder-name lab-${ID}-recorder`)) >= 0);
  assert.ok(at(/stop-configuration-recorder/) < at(new RegExp(`^aws configservice delete-delivery-channel --delivery-channel-name lab-${ID}-channel`)));
  assert.ok(at(/delete-delivery-channel/) < at(new RegExp(`^aws configservice delete-configuration-recorder --configuration-recorder-name lab-${ID}-recorder`)));
  assert.ok(!calls.some((c) => /configservice (stop|delete)-\S+ --\S+ default/.test(c)), "never the account's own recorder or channel");
  assert.ok(at(new RegExp(`^aws cloudwatch delete-dashboards --dashboard-names lab-${ID}-ops`)) >= 0);
  assert.ok(at(/^aws logs delete-query-definition --query-definition-id qd-1/) >= 0);
  assert.match(r.out, /::warning::.*no handler for sagemaker:notebook-instance yet: lab-x \(left for Verify clean to report\)/);
  assert.doesNotMatch(r.out, /123456789012/);
  w.cleanup();
});

// ── Final review, Important 2: security group rules and load balancer listeners (and listener rules) ──
const ELB = (r) => `arn:aws:elasticloadbalancing:eu-west-2:123456789012:${r}`;
const LB = ELB("loadbalancer/app/alb-a03k3x9q/50dc6c495c0c9188");
const LISTENER = ELB("listener/app/alb-a03k3x9q/50dc6c495c0c9188/f2f7dc8efc522ab2");
const LRULE = ELB("listener-rule/app/alb-a03k3x9q/50dc6c495c0c9188/f2f7dc8efc522ab2/9683b2d02a6cabee");
const TG = ELB("targetgroup/tg-a03k3x9q/73e2d6bc24d8a067");

test("Verify clean: tagging-API ghosts of a security group rule, a listener and a listener rule count clean (NotFound or an empty answer)", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("security-group-rule/sgr-0aaaaaaaaaaaaaaa1"), A("security-group-rule/sgr-0aaaaaaaaaaaaaaa2"), LISTENER, LRULE) },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa1", code: 254, err: "An error occurred (InvalidSecurityGroupRuleId.NotFound) when calling the DescribeSecurityGroupRules operation: 123456789012" },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa2", out: '{"SecurityGroupRules":[]}' },
    { cmd: "aws", match: "^elbv2 describe-listeners --listener-arns", code: 254, err: "An error occurred (ListenerNotFound) when calling the DescribeListeners operation: One or more listeners not found" },
    { cmd: "aws", match: "^elbv2 describe-rules --rule-arns", code: 254, err: "An error occurred (RuleNotFound) when calling the DescribeRules operation: One or more rules not found" },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 0, r.out + readFileSync(out, "utf8"));
  assert.match(readFileSync(out, "utf8"), /^clean=true\nleftovers=\[\]$/m);
  // Each asked by its own id or ARN, never by the tagging API alone.
  const calls = w.calls();
  assert.ok(calls.some((c) => c === `aws elbv2 describe-listeners --listener-arns ${LISTENER} --region eu-west-2 --output json`), calls.join("\n"));
  assert.ok(calls.some((c) => c === `aws elbv2 describe-rules --rule-arns ${LRULE} --region eu-west-2 --output json`), calls.join("\n"));
  assert.equal(calls.filter((c) => /^aws \S+ (delete|revoke)/.test(c)).length, 0, "verify never deletes");
  w.cleanup();
});

test("Verify clean: a security group rule or a listener still there is a named leftover, not 'no handler'", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("security-group-rule/sgr-0aaaaaaaaaaaaaaa1"), LISTENER) },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa1", out: '{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0aaaaaaaaaaaaaaa1","GroupId":"sg-0c","IsEgress":false}]}' },
    { cmd: "aws", match: "^elbv2 describe-listeners --listener-arns", out: `{"Listeners":[{"ListenerArn":"${LISTENER}","Port":80}]}` },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1, r.out);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["ec2:security-group-rule sgr-0aaaaaaaaaaaaaaa1", "elasticloadbalancing:listener app/alb-a03k3x9q/50dc6c495c0c9188/f2f7dc8efc522ab2"].sort());
  assert.doesNotMatch(r.out + readFileSync(out, "utf8"), /123456789012/);
  w.cleanup();
});

test("safety net: listeners and their rules go with the load balancer (no extra delete); ones still there are deleted, rules then listeners, before target groups", { skip }, () => {
  // With the load balancer: deleting it took the listener and rule along, so they answer NotFound and are not deleted again.
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(LB, LISTENER, LRULE, TG) },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", code: 254, err: "An error occurred (LoadBalancerNotFound)" },
    { cmd: "aws", match: "^elbv2 describe-listeners --listener-arns", code: 254, err: "An error occurred (ListenerNotFound)" },
    { cmd: "aws", match: "^elbv2 describe-rules --rule-arns", code: 254, err: "An error occurred (RuleNotFound)" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.ok(calls.some((c) => c.startsWith(`aws elbv2 delete-load-balancer --load-balancer-arn ${LB}`)));
  assert.ok(!calls.some((c) => /^aws elbv2 delete-(listener|rule)/.test(c)), calls.join("\n"));
  assert.doesNotMatch(r.out, /no handler for elasticloadbalancing/);
  w.cleanup();
  // Without its load balancer among the lab's items (or still there): the rule, then the listener, by ARN, before the target group.
  const v = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(LISTENER, LRULE, TG, ELB("listener-rule/app/alb-a03k3x9q/50dc6c495c0c9188/f2f7dc8efc522ab2/0default")) },
    { cmd: "aws", match: "^elbv2 describe-listeners --listener-arns", out: `{"Listeners":[{"ListenerArn":"${LISTENER}"}]}` },
    { cmd: "aws", match: "^elbv2 describe-rules --rule-arns \\S+/0default", out: '{"Rules":[{"IsDefault":true}]}' },
    { cmd: "aws", match: "^elbv2 describe-rules --rule-arns", out: `{"Rules":[{"RuleArn":"${LRULE}","IsDefault":false}]}` },
    ...EMPTY_IAM,
  ]);
  const s = v.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(s.status, 0, s.out);
  const c2 = v.calls();
  const at = (re) => c2.findIndex((c) => re.test(c));
  assert.ok(at(new RegExp(`^aws elbv2 delete-rule --rule-arn ${LRULE.replace(/[/.]/g, "\\$&")} `)) >= 0, c2.join("\n"));
  assert.ok(!c2.some((c) => /delete-rule --rule-arn \S+\/0default/.test(c)), "a listener's default rule goes with the listener");
  assert.ok(at(/^aws elbv2 delete-rule/) < at(/^aws elbv2 delete-listener --listener-arn /));
  assert.ok(at(/^aws elbv2 delete-listener/) < at(/^aws elbv2 delete-target-group/));
  v.cleanup();
});

test("safety net: a security group rule goes with its group; one still there is revoked by id after the groups, never in the VPN server's VPC", { skip }, () => {
  // Its group was the lab's and is deleted: the rule answers NotFound afterwards, so nothing more is asked.
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("security-group/sg-0c"), A("security-group-rule/sgr-0aaaaaaaaaaaaaaa1")) },
    { cmd: "aws", match: "^ec2 describe-security-groups --group-ids sg-0c", out: '{"SecurityGroups":[{"GroupId":"sg-0c","GroupName":"lab-vms","VpcId":"vpc-0a","IpPermissions":[],"IpPermissionsEgress":[]}]}' },
    { cmd: "aws", match: "^ec2 describe-security-group-rules", code: 254, err: "An error occurred (InvalidSecurityGroupRuleId.NotFound)" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  assert.ok(w.calls().some((c) => /^aws ec2 delete-security-group --group-id sg-0c/.test(c)));
  assert.ok(!w.calls().some((c) => /^aws ec2 revoke-security-group-(ingress|egress) --group-id \S+ --security-group-rule-ids/.test(c)));
  assert.doesNotMatch(r.out, /no handler for ec2:security-group-rule/);
  w.cleanup();
  // Still there (its group is not among the lab's items): revoked by its id, egress as egress, after the fabric.
  const v = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("subnet/subnet-0b"), A("security-group-rule/sgr-0aaaaaaaaaaaaaaa1"), A("security-group-rule/sgr-0aaaaaaaaaaaaaaa2"), A("security-group-rule/sgr-0aaaaaaaaaaaaaaa3")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --filters Name=tag:wg-admin,Values=vpn", out: '{"Vpcs":[{"VpcId":"vpc-0wg"}]}' },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa1", out: '{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0aaaaaaaaaaaaaaa1","GroupId":"sg-0other","IsEgress":false}]}' },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa2", out: '{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0aaaaaaaaaaaaaaa2","GroupId":"sg-0other","IsEgress":true}]}' },
    { cmd: "aws", match: "^ec2 describe-security-group-rules --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa3", out: '{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0aaaaaaaaaaaaaaa3","GroupId":"sg-0wg","IsEgress":false}]}' },
    { cmd: "aws", match: "^ec2 describe-security-groups --group-ids sg-0other", out: '{"SecurityGroups":[{"GroupId":"sg-0other","VpcId":"vpc-0a"}]}' },
    { cmd: "aws", match: "^ec2 describe-security-groups --group-ids sg-0wg", out: '{"SecurityGroups":[{"GroupId":"sg-0wg","VpcId":"vpc-0wg"}]}' },
    { cmd: "aws", match: "^ec2 describe-subnets --subnet-ids subnet-0b", out: '{"Subnets":[{"SubnetId":"subnet-0b","VpcId":"vpc-0a"}]}' },
    ...EMPTY_IAM,
  ]);
  const s = v.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(s.status, 0, s.out);
  const c2 = v.calls();
  const at = (re) => c2.findIndex((c) => re.test(c));
  assert.ok(at(/^aws ec2 revoke-security-group-ingress --group-id sg-0other --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa1/) >= 0, c2.join("\n"));
  assert.ok(at(/^aws ec2 revoke-security-group-egress --group-id sg-0other --security-group-rule-ids sgr-0aaaaaaaaaaaaaaa2/) >= 0, c2.join("\n"));
  assert.ok(at(/^aws ec2 delete-subnet --subnet-id subnet-0b/) < at(/^aws ec2 revoke-security-group-ingress --group-id sg-0other/), "after the fabric");
  assert.ok(!c2.some((c) => /^aws ec2 revoke\S* .*(sg-0wg|sgr-0aaaaaaaaaaaaaaa3)/.test(c)), "never in the VPN server's VPC");
  assert.match(s.out, /::warning::.*sgr-0aaaaaaaaaaaaaaa3.*VPN server/);
  // The VPN server's VPC could not be found: nothing is revoked.
  const blind = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("security-group-rule/sgr-0aaaaaaaaaaaaaaa1")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --filters Name=tag:wg-admin,Values=vpn", code: 254, err: "An error occurred (RequestLimitExceeded)" },
    { cmd: "aws", match: "^ec2 describe-security-group-rules", out: '{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0aaaaaaaaaaaaaaa1","GroupId":"sg-0other","IsEgress":false}]}' },
    ...EMPTY_IAM,
  ]);
  const b = blind.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(b.status, 0, b.out);
  assert.ok(!blind.calls().some((c) => /^aws ec2 revoke/.test(c)));
  v.cleanup();
  blind.cleanup();
});

// Release test 2026-10-15 (soa-05 run 38785247607, ruling A58): RDS deletes a database's automated snapshots
// (rds:<db>-<time>) itself, minutes after the database. The sweep never asks to delete one (AWS refuses:
// InvalidDBSnapshotState); Verify clean waits for them, and one being deleted counts clean.
const SNAP = (id) => `arn:aws:rds:eu-west-2:123456789012:snapshot:${id}`;
test("safety net leaves an automated RDS snapshot to go with its database, and deletes a manual one", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(SNAP("rds:db-a05k3x9q-2026-10-15-18-40"), SNAP("lab-manual")) },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const deletes = w.calls().filter((c) => /^aws rds delete-db-snapshot/.test(c));
  assert.deepEqual(deletes.map((c) => /--db-snapshot-identifier (\S+)/.exec(c)[1]), ["lab-manual"]);
  assert.doesNotMatch(r.out, /::warning::/);
  w.cleanup();
});

test("Verify clean waits for automated RDS snapshots to go with their database; one being deleted is clean; one still there at the deadline is named", { skip }, () => {
  const avail = '{"DBSnapshots":[{"DBSnapshotIdentifier":"rds:db-a05k3x9q-2026-10-15-18-40","SnapshotType":"automated","Status":"available"}]}';
  const deleting = '{"DBSnapshots":[{"DBSnapshotIdentifier":"rds:db-a05k3x9q-2026-10-15-18-37","SnapshotType":"automated","Status":"deleting"}]}';
  const gone = "An error occurred (DBSnapshotNotFound) when calling the DescribeDBSnapshots operation: not found";
  const rules = [
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(SNAP("rds:db-a05k3x9q-2026-10-15-18-40"), SNAP("rds:db-a05k3x9q-2026-10-15-18-37")) },
    { cmd: "aws", match: "^rds describe-db-snapshots --db-snapshot-identifier rds:db-a05k3x9q-2026-10-15-18-37", out: deleting },
    ...EMPTY_IAM,
  ];
  const w = world([{ cmd: "aws", match: "^rds describe-db-snapshots --db-snapshot-identifier rds:db-a05k3x9q-2026-10-15-18-40", out: [avail, avail, ""], code: [0, 0, 254], err: ["", "", gone] }, ...rules]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(out, "utf8"), /^clean=true$/m);
  assert.ok(w.calls().filter((c) => /describe-db-snapshots --db-snapshot-identifier rds:db-a05k3x9q-2026-10-15-18-40/.test(c)).length >= 3, "polled until gone");
  w.cleanup();
  // At the deadline (LAB_JOB_DEADLINE less 420 s already passed) it is not waited for: named.
  const late = world([{ cmd: "aws", match: "^rds describe-db-snapshots --db-snapshot-identifier rds:db-a05k3x9q-2026-10-15-18-40", out: avail }, ...rules]);
  const out2 = join(late.dir, "gh-output");
  writeFileSync(out2, "");
  const l = late.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, LAB_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 60), GITHUB_OUTPUT: fwd(out2) });
  assert.equal(l.status, 1, l.out);
  assert.deepEqual(JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out2, "utf8"))[1]), ["rds:snapshot rds:db-a05k3x9q-2026-10-15-18-40"]);
  late.cleanup();
});

// Release test 2026-10-15 (soa-05): Terraform had already deleted the Instance Connect Endpoint; the tagging API still
// listed it and the sweep's second delete was refused (a warning). One delete-complete is left alone.
test("safety net does not delete an Instance Connect Endpoint that is already delete-complete", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("instance-connect-endpoint/eice-0a"), A("instance-connect-endpoint/eice-0b")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --filters", out: '{"Vpcs":[]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints --instance-connect-endpoint-ids eice-0a", out: '{"InstanceConnectEndpoints":[{"VpcId":"vpc-0l","State":"delete-complete"}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints --instance-connect-endpoint-ids eice-0b", out: ['{"InstanceConnectEndpoints":[{"VpcId":"vpc-0l","State":"create-complete"}]}', '{"InstanceConnectEndpoints":[{"VpcId":"vpc-0l","State":"delete-complete"}]}'] },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const deletes = w.calls().filter((c) => /^aws ec2 delete-instance-connect-endpoint/.test(c));
  assert.deepEqual(deletes.map((c) => /--instance-connect-endpoint-id (\S+)/.exec(c)[1]), ["eice-0b"]);
  assert.doesNotMatch(r.out, /::warning::/);
  w.cleanup();
});

// ── Batch 2 (Task 4): stacks, ECS, CloudFront, Route 53, KMS, secrets, Lambda, ECR, Access Analyzer, flow logs, lab 07's user ──
const G = { ...ENV, LAB_REGIONS: "us-east-1" };
const ARNOF = (svc, rest, region = "eu-west-2") => `arn:aws:${svc}:${region}:123456789012:${rest}`;
const writes = (w, re = /^aws \S+ (delete|terminate|stop|update|deregister|schedule|deactivate|change|disable)/) => w.calls().filter((c) => re.test(c));
const before = (list, a, b) => list.findIndex((c) => a.test(c)) >= 0 && list.findIndex((c) => a.test(c)) < list.findIndex((c) => b.test(c));

test("Review Focus 1: a stack that ends DELETE_FAILED is force-deleted, and what it left goes by its own handler", { skip }, () => {
  const stack = ARNOF("cloudformation", "stack/lab-soa-06-cloudformation-stack/0abc");
  const st = (s) => JSON.stringify({ Stacks: [{ StackName: "lab-soa-06-cloudformation-stack", StackStatus: s }] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(stack, ARNOF("sqs", "lab-soa-06-cloudformation-stack-WorkQueue-AbC")) },
    { cmd: "aws", match: "^cloudformation describe-stacks", out: [st("CREATE_COMPLETE"), st("DELETE_FAILED"), st("DELETE_FAILED"), st("DELETE_COMPLETE")] },
    { cmd: "aws", match: "^sqs get-queue-url", out: '{"QueueUrl":"https://sqs.eu-west-2.amazonaws.com/123456789012/lab-soa-06-cloudformation-stack-WorkQueue-AbC"}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-06-cloudformation"], ENV).status, 0);
  const ws = writes(w);
  assert.equal(ws.filter((c) => c.startsWith("aws cloudformation delete-stack")).length, 2);
  assert.ok(before(ws, /delete-stack --stack-name \S+ --region/, /--deletion-mode FORCE_DELETE_STACK/));
  assert.ok(before(ws, /FORCE_DELETE_STACK/, /^aws sqs delete-queue --queue-url https:\/\/sqs/));
  w.cleanup();
});

test("Review Focus 1: CloudFront is disabled, waited for until Deployed, deleted with the new ETag, then its origin access control", { skip }, () => {
  const dist = "arn:aws:cloudfront::123456789012:distribution/E1ABC";
  const d = (status, enabled, etag) => JSON.stringify({ ETag: etag, Distribution: { Id: "E1ABC", Status: status, DistributionConfig: { Enabled: enabled } } });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(dist) },
    { cmd: "aws", match: "^cloudfront list-origin-access-controls", out: JSON.stringify({ OriginAccessControlList: { Items: [{ Id: "OAC1", Name: "lab-soa-09-route53-cloudfront-a09k3x9q" }, { Id: "OAC2", Name: "someone-else" }] } }) },
    { cmd: "aws", match: "^cloudfront get-distribution-config", out: JSON.stringify({ ETag: "E1", DistributionConfig: { Enabled: true, Comment: "lab" } }) },
    { cmd: "aws", match: "^cloudfront get-distribution --id", out: [d("InProgress", false, "E2"), d("Deployed", false, "E3")] },
    { cmd: "aws", match: "^cloudfront get-origin-access-control --id OAC1", out: '{"ETag":"O1","OriginAccessControl":{"Id":"OAC1"}}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-09-route53-cloudfront"], G).status, 0);
  const ws = writes(w, /^aws cloudfront (update|delete)/);
  assert.match(ws[0], /^aws cloudfront update-distribution --id E1ABC --if-match E1 --distribution-config file:\/\/\S+ --region us-east-1$/);
  assert.match(ws[1], /^aws cloudfront delete-distribution --id E1ABC --if-match E3 --region us-east-1$/);
  assert.match(ws[2], /^aws cloudfront delete-origin-access-control --id OAC1 --if-match O1 --region us-east-1$/);
  assert.equal(ws.length, 3, "never someone else's origin access control");
  // Pre-flight C3: the lab-service listings run only in the lab regions (wg-admin-labs is refused them in us-east-1).
  assert.ok(!w.calls().some((c) => /(cloudwatch|configservice|logs|kms) \S+ .*--region us-east-1/.test(c)), "no lab-service listing in a global region");
  w.cleanup();
});

// The change batch file lives in the script's temp folder, which is gone when the script ends, so the NS/SOA filter is
// pinned by running the script's own jq line on the same answer.
test("Route 53: the records go in one batch (never the zone's own NS and SOA), then the zone, then its health check", { skip }, () => {
  const jqLine = readFileSync(join(REPO, "infra", "ci", "lab-aws-safety-net.sh"), "utf8").match(/jq --arg n "\$name" '([^']+)'/)[1];
  const rr = { ResourceRecordSets: [{ Name: "z.", Type: "NS" }, { Name: "z.", Type: "SOA" }, { Name: "www.z.", Type: "CNAME" }, { Name: "sub.z.", Type: "NS" }] };
  const filtered = spawnSync(BASH, ["-c", `jq -c --arg n z. '${jqLine}'`], { input: JSON.stringify(rr), encoding: "utf8" });
  assert.deepEqual(JSON.parse(filtered.stdout).Changes.map((c) => `${c.ResourceRecordSet.Name} ${c.ResourceRecordSet.Type}`), ["www.z. CNAME", "sub.z. NS"]);
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:route53:::hostedzone/Z0LAB", "arn:aws:route53:::healthcheck/hc-1") },
    { cmd: "aws", match: "^route53 get-hosted-zone", out: '{"HostedZone":{"Id":"/hostedzone/Z0LAB","Name":"a09k3x9q.labs.clydeford.net."}}' },
    { cmd: "aws", match: "^route53 list-resource-record-sets", out: JSON.stringify({ ResourceRecordSets: [{ Name: "a09k3x9q.labs.clydeford.net.", Type: "NS" }, { Name: "a09k3x9q.labs.clydeford.net.", Type: "SOA" }, { Name: "www.a09k3x9q.labs.clydeford.net.", Type: "CNAME", SetIdentifier: "primary", Failover: "PRIMARY", TTL: 60, ResourceRecords: [{ Value: "blue" }] }] }) },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-09-route53-cloudfront"], G).status, 0);
  const ws = writes(w, /^aws route53 (change|delete)/);
  assert.equal(ws.length, 3);
  assert.match(ws[0], /^aws route53 change-resource-record-sets --hosted-zone-id Z0LAB --change-batch file:\/\//);
  assert.match(ws[1], /^aws route53 delete-hosted-zone --id Z0LAB/);
  assert.match(ws[2], /^aws route53 delete-health-check --health-check-id hc-1/);
  w.cleanup();
});

test("ECS: services scaled to 0 and deleted, then the cluster; task definitions deregistered and deleted (ruling P12)", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARNOF("ecs", "cluster/lab-soa-10-containers"), ARNOF("ecs", "service/lab-soa-10-containers/lab-soa-10-containers-web"), ARNOF("ecs", "task-definition/lab-soa-10-containers-web:1")) },
    { cmd: "aws", match: "^ecs describe-services", out: ['{"services":[{"status":"ACTIVE"}]}', '{"services":[{"status":"INACTIVE"}]}'] },
    { cmd: "aws", match: "^ecs describe-clusters", out: ['{"clusters":[{"status":"ACTIVE"}]}'] },
    { cmd: "aws", match: "^ecs describe-task-definition", out: '{"taskDefinition":{"status":"ACTIVE"}}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-10-containers"], ENV).status, 0);
  const ws = writes(w, /^aws ecs /);
  const order = ["update-service", "delete-service", "delete-cluster", "deregister-task-definition", "delete-task-definitions"].map((v) => ws.findIndex((c) => c.startsWith(`aws ecs ${v} `)));
  assert.ok(order.every((x, k) => x >= 0 && (k === 0 || x > order[k - 1])), ws.join("\n"));
  assert.match(ws.find((c) => c.startsWith("aws ecs delete-service")), /--force/);
  w.cleanup();
});

test("ruling P6: hand-made keys, MFA devices and SSH keys go before lab 07's user", { skip }, () => {
  const n = "lab-soa-07-iam-kms-ann";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^iam list-roles", out: '{"Roles":[]}' },
    { cmd: "aws", match: "^iam list-instance-profiles", out: '{"InstanceProfiles":[]}' },
    { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
    { cmd: "aws", match: "^iam list-users", out: JSON.stringify({ Users: [{ UserName: n }, { UserName: "steven" }] }) },
    { cmd: "aws", match: "^iam list-access-keys", out: '{"AccessKeyMetadata":[{"AccessKeyId":"AKIAEXAMPLE1"}]}' },
    { cmd: "aws", match: "^iam list-mfa-devices", out: '{"MFADevices":[{"SerialNumber":"arn:aws:iam::123456789012:mfa/ann"}]}' },
    { cmd: "aws", match: "^iam list-ssh-public-keys", out: '{"SSHPublicKeys":[{"SSHPublicKeyId":"APKAEXAMPLE"}]}' },
    { cmd: "aws", match: "^iam list-attached-user-policies", out: '{"AttachedPolicies":[]}' },
    { cmd: "aws", match: "^iam list-user-policies", out: '{"PolicyNames":[]}' },
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-07-iam-kms"], ENV).status, 0);
  const ws = writes(w, /^aws iam (delete|deactivate)/);
  for (const v of ["delete-access-key", "deactivate-mfa-device", "delete-ssh-public-key"]) assert.ok(before(ws, new RegExp(`^aws iam ${v} --user-name ${n} `), /^aws iam delete-user /), v);
  assert.ok(!ws.some((c) => c.includes("steven")), "never a user outside the lab's prefix");
  w.cleanup();
});

test("ruling P11: the key is scheduled for deletion (7 days) after its alias goes; Verify clean counts a pending key clean", { skip }, () => {
  const key = ARNOF("kms", "key/1234abcd-12ab-34cd-56ef-1234567890ab");
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(key) },
    { cmd: "aws", match: "^kms list-aliases --key-id", out: '{"Aliases":[]}' },
    { cmd: "aws", match: "^kms list-aliases", out: '{"Aliases":[{"AliasName":"alias/lab-soa-07-iam-kms-data","TargetKeyId":"1234abcd-12ab-34cd-56ef-1234567890ab"}]}' },
    { cmd: "aws", match: "^kms describe-key", out: ['{"KeyMetadata":{"KeyState":"Enabled"}}', '{"KeyMetadata":{"KeyState":"PendingDeletion"}}'] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-07-iam-kms"], ENV).status, 0);
  const ws = writes(w, /^aws kms /);
  assert.ok(before(ws, /^aws kms delete-alias --alias-name alias\/lab-soa-07-iam-kms-data/, /^aws kms schedule-key-deletion --key-id 1234abcd-12ab-34cd-56ef-1234567890ab --pending-window-in-days 7/), ws.join("\n"));
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "soa-07-iam-kms"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 0, readFileSync(out, "utf8"));
  w.cleanup();
});

test("Verify clean judges batch 2's types by their real state; an inactive task definition and an enabled key are named", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARNOF("cloudformation", "stack/s/0abc"), ARNOF("ecs", "cluster/c"), ARNOF("ecs", "task-definition/t:1"), ARNOF("ecs", "task-definition/t:2"), ARNOF("secretsmanager", "secret:lab-x-AbCdEf"), ARNOF("sqs", "q"), ARNOF("kms", "key/k1"), ARNOF("lambda", "function:f"), ARNOF("ec2", "vpc-flow-log/fl-0abc")) },
    { cmd: "aws", match: "^cloudformation describe-stacks", out: '{"Stacks":[{"StackStatus":"DELETE_COMPLETE"}]}' },
    { cmd: "aws", match: "^ecs describe-clusters", out: '{"clusters":[{"status":"INACTIVE"}]}' },
    { cmd: "aws", match: "task-definition/t:1", out: '{"taskDefinition":{"status":"DELETE_IN_PROGRESS"}}' },
    { cmd: "aws", match: "task-definition/t:2", out: '{"taskDefinition":{"status":"INACTIVE"}}' },
    { cmd: "aws", match: "^secretsmanager describe-secret", out: "", code: 254, err: "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: x" },
    { cmd: "aws", match: "^sqs get-queue-url", out: "", code: 254, err: "An error occurred (AWS.SimpleQueueService.NonExistentQueue) when calling the GetQueueUrl operation: x" },
    { cmd: "aws", match: "^kms describe-key", out: '{"KeyMetadata":{"KeyState":"Enabled"}}' },
    { cmd: "aws", match: "^lambda get-function-configuration", out: "", code: 254, err: "An error occurred (ResourceNotFoundException) when calling the GetFunctionConfiguration operation: x" },
    { cmd: "aws", match: "^ec2 describe-flow-logs", out: '{"FlowLogs":[]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["ecs:task-definition t:2", "kms:key k1"]);
  w.cleanup();
});

test("ruling P18: Unblock changes an RDS instance's deletion protection only when it is not already off", { skip }, () => {
  const db = (on) => world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q") },
    { cmd: "aws", match: "^rds describe-db-instances", out: JSON.stringify({ DBInstances: [{ DeletionProtection: on }] }) },
  ]);
  for (const [on, calls] of [[false, 0], [true, 1]]) {
    const w = db(on);
    assert.equal(w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV).status, 0);
    assert.equal(w.calls().filter((c) => c.startsWith("aws rds modify-db-instance")).length, calls, String(on));
    w.cleanup();
  }
});

// Pre-flight C3: Unblock's Config recorder listing runs only in the lab regions, never in a global one.
test("Unblock lists Config recorders only in the lab regions (never us-east-1 or us-west-2)", { skip }, () => {
  const w = world([{ cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() }]);
  assert.equal(w.run("infra/ci/lab-unblock-aws.sh", [ID], { ...ENV, LAB_REGIONS: "eu-west-2 us-east-1 us-west-2" }).status, 0);
  const listings = w.calls().filter((c) => /^aws configservice describe-configuration-recorders/.test(c));
  assert.deepEqual(listings.map((c) => /--region (\S+)/.exec(c)[1]), ["eu-west-2"]);
  w.cleanup();
});

// ── Batch 3 (Task 4): EKS, global tables, EFS, ElastiCache, API Gateway, Cognito, workflows, buses, streams, Glue, Athena, AMI copies ──
const ARN3 = (svc, rest) => `arn:aws:${svc}:eu-west-2:123456789012:${rest}`;
const calls3 = (w, re) => w.calls().filter((c) => re.test(c));
const idx = (list, re) => list.findIndex((c) => re.test(c));

test("Review Focus 4 / P21: a global table's replicas go first, then the table; a table found only by name goes too", { skip }, () => {
  const t = "lab-saa-16-dr-pilot-light-orders";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("dynamodb", `table/${t}`)) },
    { cmd: "aws", match: "^dynamodb list-tables", out: JSON.stringify({ TableNames: [t, "lab-saa-16-dr-pilot-light-stray", "someone-elses"] }) },
    // Pre-flight C5: each ends DELETING (the fake AWS repeats its last answer), so the wait reaches "gone".
    { cmd: "aws", match: `^dynamodb describe-table --table-name ${t} `, out: [JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [{ RegionName: "eu-west-1" }] } }), JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [] } }), JSON.stringify({ Table: { TableStatus: "DELETING" } })] },
    { cmd: "aws", match: "^dynamodb describe-table --table-name lab-saa-16-dr-pilot-light-stray ", out: [JSON.stringify({ Table: { TableStatus: "ACTIVE" } }), JSON.stringify({ Table: { TableStatus: "ACTIVE" } }), JSON.stringify({ Table: { TableStatus: "DELETING" } })] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV).status, 0);
  const ws = calls3(w, /^aws dynamodb (update-table|delete-table)/);
  assert.match(ws[0], /^aws dynamodb update-table --table-name lab-saa-16-dr-pilot-light-orders --replica-updates Delete=\{RegionName=eu-west-1\} --region eu-west-2$/);
  assert.ok(idx(ws, /^aws dynamodb update-table/) < idx(ws, new RegExp(`^aws dynamodb delete-table --table-name ${t} `)), ws.join("\n"));
  assert.ok(ws.some((c) => c.startsWith("aws dynamodb delete-table --table-name lab-saa-16-dr-pilot-light-stray ")), "found by name (ruling P3)");
  assert.ok(!ws.some((c) => c.includes("someone-elses")));
  w.cleanup();
});

test("Review Focus 4: EKS node groups, then the cluster, each waited for until AWS no longer has it", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks"), ARN3("eks", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/0abc")) },
    // Fix round 1 (I1): each handler reads the item first, so the first answer is the one before the delete.
    { cmd: "aws", match: "^eks describe-nodegroup", out: ['{"nodegroup":{"status":"ACTIVE"}}', '{"nodegroup":{"status":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^eks describe-cluster", out: ['{"cluster":{"status":"ACTIVE"}}', '{"cluster":{"status":"DELETING"}}', "{}"] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-19-eks"], ENV).status, 0);
  const ws = calls3(w, /^aws eks /);
  const ng = idx(ws, /^aws eks delete-nodegroup --cluster-name lab-saa-19-eks --nodegroup-name lab-saa-19-eks-ng --region eu-west-2$/);
  const cl = idx(ws, /^aws eks delete-cluster --name lab-saa-19-eks --region eu-west-2$/);
  assert.ok(ng >= 0 && cl > ng, ws.join("\n"));
  assert.ok(ws.slice(ng, cl).filter((c) => c.startsWith("aws eks describe-nodegroup")).length >= 2, "the node group was waited for until gone");
  w.cleanup();
});

test("Review Focus 4: EFS mount targets, then the file system; ElastiCache's group, never its member cluster, then the subnet group", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("elasticfilesystem", "file-system/fs-0abc"), ARN3("elasticache", "replicationgroup:ca11k3x9q"), ARN3("elasticache", "cluster:ca11k3x9q-001"), ARN3("elasticache", "subnetgroup:lab-saa-11-three-tier-cache")) },
    { cmd: "aws", match: "^efs describe-mount-targets", out: ['{"MountTargets":[{"MountTargetId":"fsmt-1"},{"MountTargetId":"fsmt-2"}]}', '{"MountTargets":[]}'] },
    { cmd: "aws", match: "^efs describe-file-systems", out: ['{"FileSystems":[{"LifeCycleState":"deleting"}]}', '{"FileSystems":[]}'] },
    { cmd: "aws", match: "^elasticache describe-replication-groups", out: ['{"ReplicationGroups":[{"Status":"available"}]}', '{"ReplicationGroups":[{"Status":"deleting"}]}', '{"ReplicationGroups":[]}'] },
    { cmd: "aws", match: "^elasticache describe-cache-clusters", out: '{"CacheClusters":[{"CacheClusterId":"ca11k3x9q-001","ReplicationGroupId":"ca11k3x9q"}]}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-11-three-tier"], ENV).status, 0);
  const efs = calls3(w, /^aws efs delete-/);
  assert.deepEqual(efs.map((c) => c.split(" --region")[0]), ["aws efs delete-mount-target --mount-target-id fsmt-1", "aws efs delete-mount-target --mount-target-id fsmt-2", "aws efs delete-file-system --file-system-id fs-0abc"]);
  const ec = calls3(w, /^aws elasticache delete-/);
  assert.deepEqual(ec.map((c) => c.split(" --region")[0]), ["aws elasticache delete-replication-group --replication-group-id ca11k3x9q --no-retain-primary-cluster", "aws elasticache delete-cache-subnet-group --cache-subnet-group-name lab-saa-11-three-tier-cache"]);
  w.cleanup();
});

test("ruling P4: an AMI found by name is deregistered and its snapshots deleted after it", { skip }, () => {
  const img = JSON.stringify({ Images: [{ ImageId: "ami-0aaa1111bbbb2222c", Name: "lab-saa-16-dr-pilot-light-al2023-a16k3x9q", State: "available", BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-0ddd3333eeee4444f" } }] }] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-images --owners self", out: img },
    { cmd: "aws", match: "^ec2 describe-images --image-ids", out: img },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV).status, 0);
  assert.ok(w.calls().some((c) => c.startsWith("aws ec2 describe-images --owners self --filters Name=name,Values=lab-saa-16-dr-pilot-light-* ")));
  const ws = calls3(w, /^aws ec2 (deregister-image|delete-snapshot)/).map((c) => c.split(" --region")[0]);
  assert.deepEqual(ws, ["aws ec2 deregister-image --image-id ami-0aaa1111bbbb2222c", "aws ec2 delete-snapshot --snapshot-id snap-0ddd3333eeee4444f"]);
  w.cleanup();
});

test("batch 3's workloads go by their own handlers: API, pool (domain first), workflow, bus after its rule, Firehose before its stream, a running crawler stopped, workgroup", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:apigateway:eu-west-2::/apis/a1b2c3", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3/stages/$default", ARN3("cognito-idp", "userpool/eu-west-2_AbC"), ARN3("states", "stateMachine:lab-x-orders"), ARN3("events", "event-bus/lab-x-bus"), ARN3("events", "rule/lab-x-bus/lab-x-placed"), ARN3("kinesis", "stream/lab-x-events"), ARN3("firehose", "deliverystream/lab-x-to-s3"), ARN3("glue", "crawler/lab-x-events"), ARN3("athena", "workgroup/lab-x-wg")) },
    { cmd: "aws", match: "^cognito-idp describe-user-pool", out: '{"UserPool":{"Id":"eu-west-2_AbC","Domain":"lab-x-auth","DeletionProtection":"INACTIVE"}}' },
    { cmd: "aws", match: "^glue get-crawler", out: ['{"Crawler":{"State":"RUNNING"}}', '{"Crawler":{"State":"READY"}}'] },
    { cmd: "aws", match: "^kinesis describe-stream-summary", out: ['{"StreamDescriptionSummary":{"StreamStatus":"ACTIVE"}}', '{"StreamDescriptionSummary":{"StreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^firehose describe-delivery-stream", out: ['{"DeliveryStreamDescription":{"DeliveryStreamStatus":"ACTIVE"}}', '{"DeliveryStreamDescription":{"DeliveryStreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^events list-targets-by-rule", out: '{"Targets":[{"Id":"sfn"}]}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-13-decoupling"], ENV).status, 0);
  const ws = calls3(w, /^aws \S+ (delete|stop|remove|update)/).map((c) => c.split(" --region")[0]);
  for (const c of ["aws apigatewayv2 delete-api --api-id a1b2c3", "aws stepfunctions delete-state-machine --state-machine-arn arn:aws:states:eu-west-2:123456789012:stateMachine:lab-x-orders", "aws athena delete-work-group --work-group lab-x-wg --recursive-delete-option", "aws events delete-event-bus --name lab-x-bus"]) assert.ok(ws.includes(c), c);
  assert.ok(!ws.some((c) => /delete-stage/.test(c)), "a stage goes with its API");
  assert.ok(idx(ws, /^aws cognito-idp delete-user-pool-domain --domain lab-x-auth --user-pool-id eu-west-2_AbC$/) < idx(ws, /^aws cognito-idp delete-user-pool --user-pool-id eu-west-2_AbC$/));
  assert.ok(idx(ws, /^aws events delete-rule --name lab-x-placed --event-bus-name lab-x-bus$/) < idx(ws, /^aws events delete-event-bus/));
  assert.ok(idx(ws, /^aws firehose delete-delivery-stream --delivery-stream-name lab-x-to-s3 --allow-force-delete$/) < idx(ws, /^aws kinesis delete-stream --stream-name lab-x-events --enforce-consumer-deletion$/));
  assert.ok(idx(ws, /^aws glue stop-crawler --name lab-x-events$/) < idx(ws, /^aws glue delete-crawler --name lab-x-events$/));
  w.cleanup();
});

test("ruling P21: Verify clean judges batch 3's types: a table or workflow DELETING is clean; an EFS or stream being deleted is not", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("dynamodb", "table/t1"), ARN3("states", "stateMachine:s1"), ARN3("elasticfilesystem", "file-system/fs-1"), ARN3("kinesis", "stream/k1"), ARN3("athena", "workgroup/w1"), ARN3("glue", "database/lab_saa_17_data_pipeline")) },
    { cmd: "aws", match: "^dynamodb describe-table", out: '{"Table":{"TableStatus":"DELETING"}}' },
    { cmd: "aws", match: "^stepfunctions describe-state-machine", out: '{"status":"DELETING"}' },
    { cmd: "aws", match: "^efs describe-file-systems", out: '{"FileSystems":[{"LifeCycleState":"deleting"}]}' },
    { cmd: "aws", match: "^kinesis describe-stream-summary", out: '{"StreamDescriptionSummary":{"StreamStatus":"DELETING"}}' },
    { cmd: "aws", match: "^athena list-work-groups", out: '{"WorkGroups":[{"Name":"someone-else"}]}' },
    { cmd: "aws", match: "^glue get-database --name", out: "", code: 254, err: "An error occurred (EntityNotFoundException) when calling the GetDatabase operation: x" },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "saa-17-data-pipeline"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["elasticfilesystem:file-system fs-1", "kinesis:stream k1"]);
  w.cleanup();
});

test("Review Focus 3 / P8: Unblock deletes only the load balancers Kubernetes made for this lab's cluster, and turns off a pool's protection", { skip }, () => {
  const k8s = '{"TagDescriptions":[{"Tags":[{"Key":"kubernetes.io/cluster/lab-saa-19-eks","Value":"owned"}]}]}';
  const other = '{"TagDescriptions":[{"Tags":[{"Key":"kubernetes.io/cluster/someone","Value":"owned"}]}]}';
  const lb = (n) => `arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/net/${n}/0abc`;
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks"), ARN3("cognito-idp", "userpool/eu-west-2_AbC")) },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: lb("k8s") }, { LoadBalancerArn: lb("other") }] }) },
    { cmd: "aws", match: `^elbv2 describe-tags --resource-arns ${lb("k8s")}`, out: k8s },
    { cmd: "aws", match: `^elbv2 describe-tags --resource-arns ${lb("other")}`, out: other },
    { cmd: "aws", match: "^elb describe-load-balancers", out: '{"LoadBalancerDescriptions":[{"LoadBalancerName":"a1b2c3"},{"LoadBalancerName":"web"}]}' },
    { cmd: "aws", match: "^elb describe-tags --load-balancer-names a1b2c3", out: k8s },
    { cmd: "aws", match: "^elb describe-tags --load-balancer-names web", out: '{"TagDescriptions":[{"Tags":[]}]}' },
    { cmd: "aws", match: "^cognito-idp describe-user-pool", out: '{"UserPool":{"DeletionProtection":"ACTIVE"}}' },
  ]);
  assert.equal(w.run("infra/ci/lab-unblock-aws.sh", ["saa-19-eks"], ENV).status, 0);
  const ws = calls3(w, /^aws (elbv2|elb|cognito-idp) (delete|update)/).map((c) => c.split(" --region")[0]);
  assert.deepEqual(ws.sort(), ["aws cognito-idp update-user-pool --user-pool-id eu-west-2_AbC --deletion-protection INACTIVE", `aws elbv2 delete-load-balancer --load-balancer-arn ${lb("k8s")}`, "aws elb delete-load-balancer --load-balancer-name a1b2c3"].sort());
  w.cleanup();
});

test("ruling P8: Unblock never deletes a Kubernetes-made load balancer that also carries the VPN server's wg-admin tag", { skip }, () => {
  const lb = "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/net/k8s/0abc";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks")) },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: lb }] }) },
    { cmd: "aws", match: "^elbv2 describe-tags", out: '{"TagDescriptions":[{"Tags":[{"Key":"kubernetes.io/cluster/lab-saa-19-eks","Value":"owned"},{"Key":"wg-admin","Value":"vpn"}]}]}' },
  ]);
  assert.equal(w.run("infra/ci/lab-unblock-aws.sh", ["saa-19-eks"], ENV).status, 0);
  assert.equal(calls3(w, /^aws (elbv2|elb) delete-load-balancer/).length, 0);
  w.cleanup();
});

// Pre-flight C9: a learner can switch on an EKS cluster's deletion protection; Unblock turns it off only when it is on.
test("pre-flight C9: Unblock turns off an EKS cluster's deletion protection only when it is on", { skip }, () => {
  for (const [on, n] of [[true, 1], [false, 0]]) {
    const w = world([
      { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks")) },
      { cmd: "aws", match: "^eks describe-cluster --name lab-saa-19-eks", out: JSON.stringify({ cluster: { deletionProtection: on } }) },
    ]);
    assert.equal(w.run("infra/ci/lab-unblock-aws.sh", ["saa-19-eks"], ENV).status, 0);
    const ws = calls3(w, /^aws eks update-cluster-config/).map((c) => c.split(" --region")[0]);
    assert.deepEqual(ws, n ? ["aws eks update-cluster-config --name lab-saa-19-eks --no-deletion-protection"] : [], String(on));
    w.cleanup();
  }
});

// Pre-flight C8: an update on a global table's replica blocks the replica removal that follows, so only when it is on.
test("pre-flight C8: Unblock turns off a DynamoDB table's deletion protection only when it is on (or cannot be read)", { skip }, () => {
  const tbl = ARN3("dynamodb", "table/lab-saa-16-dr-pilot-light-orders");
  for (const [answer, n] of [[{ out: '{"Table":{"DeletionProtectionEnabled":false}}' }, 0], [{ out: '{"Table":{}}' }, 0], [{ out: '{"Table":{"DeletionProtectionEnabled":true}}' }, 1], [{ out: "", code: 254, err: "An error occurred (ThrottlingException) when calling the DescribeTable operation: x" }, 1]]) {
    const w = world([
      { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(tbl) },
      { cmd: "aws", match: "^dynamodb describe-table --table-name lab-saa-16-dr-pilot-light-orders", ...answer },
    ]);
    assert.equal(w.run("infra/ci/lab-unblock-aws.sh", ["saa-16-dr-pilot-light"], ENV).status, 0);
    const ws = calls3(w, /^aws dynamodb update-table/).map((c) => c.split(" --region")[0]);
    assert.deepEqual(ws, n ? ["aws dynamodb update-table --table-name lab-saa-16-dr-pilot-light-orders --no-deletion-protection-enabled"] : [], JSON.stringify(answer));
    w.cleanup();
  }
});

// Pre-flight C10: a crawler that cannot be read is a warning, never a wait until the deadline.
test("pre-flight C10: a crawler AWS will not describe is warned about and left, with no wait", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("glue", "crawler/lab-saa-17-data-pipeline-events")) },
    { cmd: "aws", match: "^glue get-crawler", out: "", code: 254, err: "An error occurred (AccessDeniedException) when calling the GetCrawler operation: x" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-17-data-pipeline"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.equal(calls3(w, /^aws glue get-crawler/).length, 1, "asked once");
  assert.equal(calls3(w, /^aws glue (stop|delete)-crawler/).length, 0);
  assert.match(r.out, /::warning::safety net: could not read glue:crawler lab-saa-17-data-pipeline-events \(AccessDeniedException\)/);
  w.cleanup();
});

// Pre-flight C11: EKS access entries and EC2 Fleets (mixed-instances groups) go with their cluster or group; judged only.
test("pre-flight C11: an access entry whose cluster is gone, and a deleted fleet, are clean", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "access-entry/lab-saa-19-eks/role/123456789012/lab-saa-19-eks-node/0abc"), ARN3("ec2", "fleet/fleet-0abc"), ARN3("ec2", "fleet/fleet-0live")) },
    { cmd: "aws", match: "^eks describe-cluster --name lab-saa-19-eks ", out: "", code: 254, err: "An error occurred (ResourceNotFoundException) when calling the DescribeCluster operation: x" },
    { cmd: "aws", match: "^ec2 describe-fleets --fleet-ids fleet-0abc", out: '{"Fleets":[{"FleetState":"deleted_terminating"}]}' },
    { cmd: "aws", match: "^ec2 describe-fleets --fleet-ids fleet-0live", out: '{"Fleets":[{"FleetState":"active"}]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "saa-19-eks"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left, ["ec2:fleet fleet-0live"]);
  // The sweep deletes neither (each goes with its cluster or group) and warns of no missing handler.
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-19-eks"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /no handler for (eks:access-entry|ec2:fleet)/);
  assert.equal(calls3(w, /^aws (eks delete-access-entry|ec2 delete-fleets)/).length, 0);
  w.cleanup();
});

// ── Task 4 fix round 1 ──
// I1: a destroy that ran out of time leaves a node group (or stream, or cache group) DELETING; AWS refuses a second
// delete, so it is waited for as one deleted here (as rds_wait does), and the cluster goes after it.
test("review I1: a node group already DELETING is waited for until gone, then the cluster is deleted", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks"), ARN3("eks", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/0abc"), ARN3("kinesis", "stream/lab-saa-19-eks-s"), ARN3("firehose", "deliverystream/lab-saa-19-eks-f"), ARN3("elasticache", "replicationgroup:ca19")) },
    { cmd: "aws", match: "^eks describe-nodegroup", out: ['{"nodegroup":{"status":"DELETING"}}', '{"nodegroup":{"status":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^eks describe-cluster", out: ['{"cluster":{"status":"ACTIVE"}}', "{}"] },
    { cmd: "aws", match: "^kinesis describe-stream-summary", out: ['{"StreamDescriptionSummary":{"StreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^firehose describe-delivery-stream", out: ['{"DeliveryStreamDescription":{"DeliveryStreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^elasticache describe-replication-groups", out: ['{"ReplicationGroups":[{"Status":"deleting"}]}', '{"ReplicationGroups":[]}'] },
    { cmd: "aws", match: "^eks delete-nodegroup|^kinesis delete-stream|^firehose delete-delivery-stream|^elasticache delete-replication-group", out: "", code: 254, err: "An error occurred (ResourceInUseException) when calling the Delete operation: x" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-19-eks"], ENV);
  assert.equal(r.status, 0, r.out);
  const ws = calls3(w, /^aws eks /);
  assert.equal(idx(ws, /^aws eks delete-nodegroup/), -1, "never asked again while AWS deletes it");
  const cl = idx(ws, /^aws eks delete-cluster --name lab-saa-19-eks /);
  assert.ok(cl >= 0, ws.join("\n"));
  assert.equal(ws.slice(0, cl).filter((c) => c.startsWith("aws eks describe-nodegroup")).length, 3, "read, then waited for until gone");
  assert.equal(calls3(w, /^aws (kinesis delete-stream|firehose delete-delivery-stream|elasticache delete-replication-group)/).length, 0);
  for (const re of [/^aws kinesis describe-stream-summary/, /^aws firehose describe-delivery-stream/, /^aws elasticache describe-replication-groups/]) assert.equal(calls3(w, re).length, 2, `${re} waited for`);
  assert.doesNotMatch(r.out, /left behind|could not delete/);
  w.cleanup();
});

// I2: an AMI copy's snapshots carry no tags or name; deregistering an image whose snapshots could not be read orphans
// them where Verify clean never looks. The image stays (Verify names it).
test("review I2: an AMI whose describe fails is warned about and never deregistered", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-images --owners self", out: JSON.stringify({ Images: [{ ImageId: "ami-0aaa1111bbbb2222c", Name: "lab-saa-16-dr-pilot-light-al2023-a16k3x9q" }] }) },
    { cmd: "aws", match: "^ec2 describe-images --image-ids", out: "", code: 254, err: "An error occurred (RequestLimitExceeded) when calling the DescribeImages operation: x" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.equal(calls3(w, /^aws ec2 (deregister-image|delete-snapshot)/).length, 0);
  assert.match(r.out, /::warning::safety net: could not read ec2:image ami-0aaa1111bbbb2222c .*\(RequestLimitExceeded\)/);
  w.cleanup();
});

// Minor M3: an AMI found by name that carries the VPN server's wg-admin tag is never touched.
test("review M3: an AMI found by name carrying wg-admin is never deregistered", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-images", out: JSON.stringify({ Images: [{ ImageId: "ami-0wg", Name: "lab-saa-16-dr-pilot-light-x", Tags: [{ Key: "wg-admin", Value: "vpn" }] }] }) },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.equal(calls3(w, /^aws ec2 (deregister-image|delete-snapshot)/).length, 0);
  assert.match(r.out, /::warning::safety net: never touched: ec2:image ami-0wg/);
  w.cleanup();
});

// Minors M1 and M4: a table is deleted only once AWS has finished updating it (DeleteTable refuses an UPDATING
// table), and a table or cache cluster that cannot be read is warned about, never deleted blind.
test("review M1 / M4: a table waits for UPDATING to end before its delete; an unreadable table or cache cluster is left with a warning", { skip }, () => {
  const t = "lab-saa-16-dr-pilot-light-orders";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("dynamodb", `table/${t}`), ARN3("dynamodb", "table/lab-saa-16-dr-pilot-light-unread"), ARN3("elasticache", "cluster:ca16-001")) },
    { cmd: "aws", match: `^dynamodb describe-table --table-name ${t} `, out: [JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [{ RegionName: "eu-west-1" }] } }), JSON.stringify({ Table: { TableStatus: "UPDATING", Replicas: [] } }), JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [] } }), JSON.stringify({ Table: { TableStatus: "DELETING" } })] },
    { cmd: "aws", match: "^dynamodb describe-table --table-name lab-saa-16-dr-pilot-light-unread ", out: "", code: 254, err: "An error occurred (ThrottlingException) when calling the DescribeTable operation: x" },
    { cmd: "aws", match: "^elasticache describe-cache-clusters", out: "", code: 254, err: "An error occurred (ThrottlingException) when calling the DescribeCacheClusters operation: x" },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = calls3(w, new RegExp(`^aws dynamodb \\S+ --table-name ${t} `));
  const del = idx(calls, /^aws dynamodb delete-table/);
  assert.ok(del >= 0, calls.join("\n"));
  assert.equal(calls.slice(0, del).filter((c) => c.startsWith("aws dynamodb describe-table")).length, 3, "the delete waited for UPDATING to end");
  assert.equal(calls3(w, /^aws dynamodb (update|delete)-table --table-name lab-saa-16-dr-pilot-light-unread/).length, 0);
  assert.equal(calls3(w, /^aws elasticache delete-cache-cluster/).length, 0);
  assert.match(r.out, /could not read dynamodb:table lab-saa-16-dr-pilot-light-unread \(ThrottlingException\)/);
  assert.match(r.out, /could not read elasticache:cluster ca16-001 \(ThrottlingException\)/);
  w.cleanup();
});

// ── Real AWS, 2026-10-16 (soa-10): destroy's aws_eip delete called DisassociateAddress on the NAT gateway's address,
// which AWS authorises on "*" with no tags, so ChangeNeedsLabTag3 refused it. Unblock now deletes the lab's own NAT
// gateways and waits until AWS has them deleted, so the destroy finds the address free and only releases it.
const NATQ = /^aws ec2 describe-nat-gateways --filter Name=tag:cloudlabs-lab,Values=soa-10-containers --region eu-west-2/;
const nat = (id, state, wg = false) => ({ NatGatewayId: id, State: state, Tags: [{ Key: "cloudlabs-lab", Value: "soa-10-containers" }, ...(wg ? [{ Key: "wg-admin", Value: "vpn" }] : [])] });
const nats = (...n) => JSON.stringify({ NatGateways: n });

test("NAT fix: Unblock deletes the lab's NAT gateway and waits until AWS has it deleted; a wg-admin one is never touched", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: [nats(nat("nat-0lab", "available"), nat("nat-0wg", "available", true), nat("nat-0old", "deleted")), nats(nat("nat-0lab", "deleting"), nat("nat-0wg", "available", true)), nats(nat("nat-0lab", "deleted"), nat("nat-0wg", "available", true))] },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", ["soa-10-containers"], ENV);
  assert.equal(r.status, 0, r.out);
  const ec2 = calls3(w, /^aws ec2 /);
  assert.deepEqual(calls3(w, /^aws ec2 delete-nat-gateway/).map((c) => c.split(" --region")[0]), ["aws ec2 delete-nat-gateway --nat-gateway-id nat-0lab"]);
  assert.ok(!calls3(w, /^aws ec2 (?!describe)/).some((c) => c.includes("nat-0wg")), "the VPN server's NAT is never touched");
  assert.equal(ec2.filter((c) => NATQ.test(c)).length, 3, `listed, then polled until deleted: ${ec2.join(" | ")}`);
  assert.ok(idx(ec2, /delete-nat-gateway/) < ec2.findLastIndex((c) => NATQ.test(c)), "the wait comes after the delete");
  assert.match(r.out, /::warning::.*nat-0wg.*VPN server/);
  assert.match(r.out, /NAT gateway nat-0lab is deleted/);
  w.cleanup();
});

test("NAT fix: a NAT gateway already deleting is only waited for, never deleted again", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: [nats(nat("nat-0lab", "deleting")), nats(nat("nat-0lab", "deleting")), nats(nat("nat-0lab", "deleted"))] },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", ["soa-10-containers"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.equal(calls3(w, /^aws ec2 delete-nat-gateway/).length, 0);
  assert.equal(calls3(w, NATQ).length, 3, "waited for until deleted");
  assert.match(r.out, /NAT gateway nat-0lab is deleted/);
  w.cleanup();
});

test("NAT fix: a NAT listing AWS refuses is a warning; Unblock deletes nothing there and still exits 0", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("instance/i-0lab")) },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: "", code: 254, err: "An error occurred (UnauthorizedOperation) when calling the DescribeNatGateways operation: 123456789012" },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", ["soa-10-containers"], ENV);
  assert.equal(r.status, 0, r.out);
  assert.equal(calls3(w, /^aws ec2 delete-nat-gateway/).length, 0);
  assert.equal(calls3(w, /^aws ec2 describe-nat-gateways/).length, 1, "no wait");
  assert.match(r.out, /::warning::unblock: could not list the NAT gateways in eu-west-2 \(UnauthorizedOperation\)/);
  assert.doesNotMatch(r.out, /123456789012/);
  assert.ok(w.calls().some((c) => /modify-instance-attribute --instance-id i-0lab/.test(c)), "the rest of Unblock still runs");
  w.cleanup();
});

test("NAT fix: a NAT gateway still deleting at the wait's end is a warning, never a failure; a failed poll stops the wait", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: nats(nat("nat-0lab", "deleting")) },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", ["soa-10-containers"], { ...ENV, LAB_UNBLOCK_NAT_WAIT_SECONDS: "0" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::unblock: NAT gateway nat-0lab is still deleting/);
  w.cleanup();
  const f = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: [nats(nat("nat-0lab", "available")), ""], code: [0, 254], err: ["", "An error occurred (RequestLimitExceeded) when calling the DescribeNatGateways operation: x"] },
  ]);
  const s = f.run("infra/ci/lab-unblock-aws.sh", ["soa-10-containers"], ENV);
  assert.equal(s.status, 0, s.out);
  assert.equal(calls3(f, /^aws ec2 describe-nat-gateways/).length, 2, "one failed poll ends the wait");
  assert.match(s.out, /::warning::unblock: could not read the NAT gateways in eu-west-2 \(RequestLimitExceeded\)/);
  f.cleanup();
});

test("saa-15 review I2: Unblock deletes the bucket policy of the lab's own bucket, never another bucket's, and warns if it cannot", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:s3:::cloudlabs-a15k3x9q-data", "arn:aws:s3:::someone-elses-bucket") },
    { cmd: "aws", match: "^s3api get-object-lock-configuration", out: "", code: 254, err: "ObjectLockConfigurationNotFoundError" },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const del = calls3(w, /^aws s3api delete-bucket-policy/).map((c) => c.split(" --region")[0]);
  assert.deepEqual(del, ["aws s3api delete-bucket-policy --bucket cloudlabs-a15k3x9q-data"]);
  w.cleanup();
  const f = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:s3:::cloudlabs-a15k3x9q-data") },
    { cmd: "aws", match: "^s3api delete-bucket-policy", out: "", code: 254, err: "An error occurred (AccessDenied) when calling the DeleteBucketPolicy operation" },
  ]);
  const r2 = f.run("infra/ci/lab-unblock-aws.sh", [ID], ENV);
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /::warning::.*bucket policy of cloudlabs-a15k3x9q-data/);
  f.cleanup();
});
