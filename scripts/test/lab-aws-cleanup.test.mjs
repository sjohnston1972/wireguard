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
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:states:eu-west-2:123456789012:stateMachine:lab-x") },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  assert.match(readFileSync(out, "utf8"), /no handler for states:stateMachine: lab-x/);
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
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:states:eu-west-2:123456789012:stateMachine:lab-x", "arn:aws:events:eu-west-2:123456789012:rule/lab-soa-03-auto-scaling-stop", "arn:aws:autoscaling:eu-west-2:123456789012:autoScalingGroup:0f1e2d3c-aaaa-bbbb-cccc-000000000000:autoScalingGroupName/asg-a03k3x9q") },
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
  assert.match(r.out, /::warning::.*no handler for states:stateMachine yet: lab-x \(left for Verify clean to report\)/);
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
