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
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:lambda:eu-west-2:123456789012:function:lab-x") },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  assert.match(readFileSync(out, "utf8"), /no handler for lambda:function: lab-x/);
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
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:lambda:eu-west-2:123456789012:function:lab-x", "arn:aws:events:eu-west-2:123456789012:rule/lab-soa-03-auto-scaling-stop", "arn:aws:autoscaling:eu-west-2:123456789012:autoScalingGroup:0f1e2d3c-aaaa-bbbb-cccc-000000000000:autoScalingGroupName/asg-a03k3x9q") },
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
  assert.match(r.out, /::warning::.*no handler for lambda:function yet: lab-x \(left for Verify clean to report\)/);
  assert.doesNotMatch(r.out, /123456789012/);
  w.cleanup();
});
