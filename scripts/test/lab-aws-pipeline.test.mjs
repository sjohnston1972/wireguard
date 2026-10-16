// lab-aws-pipeline.test.mjs
//
// Plain English: lab-aws.yml's own bash steps against a pretend AWS CLI
// (fixtures/labs/harness.mjs records every call): Parse payload's AWS rules,
// the per-step STS session, the ready check and peering to the VPN server's
// VPC and back (AWS labs spec §5, §5.1, ruling A25).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { BASH, fwd, JQ, REPO, world } from "./fixtures/labs/harness.mjs";
import { AWS_GLOBAL_LABS } from "../lib/labs.mjs";

const skip = BASH && JQ ? false : "needs bash and jq (CI has both)";
// "python" first: on Windows "python3" can be the Store alias; the runner has one or the other.
const PY = (() => { for (const p of ["python", "python3"]) { const r = spawnSync(p, ["-c", "import yaml"]); if (r.status === 0) return p; } return null; })();
const skipParse = !BASH ? "no bash found" : !PY ? "no Python with PyYAML here (the runner has it)" : false;
const ID = "soa-03-auto-scaling";
const LAB = { id: ID, version: 2, cloud: "aws", connectivity: { peering: "optional", dns_link: false, subnets_used: 1 }, timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 }, identity: { creates: [], roles: [], governance: false } };
const PAYLOAD = { lab_id: ID, version: 2, run_id: "lab-deploy-20261015120000-ab12cd", session_id: "ls-20261015120000-cd34ef", region: "eu-west-2", secondary_region: null, slot_cidr: "10.64.64.0/18", name_prefix: "a03k3x9q", peering: true, timeout_min: 44, callback_url: "https://wg.example.net/api/callback", secrets_url: "https://wg.example.net/api/callback/lab-secrets", gateway_cidr: "10.50.0.0/16" };

function parseRun(cloud, payload, lab = LAB, action = "deploy") {
  const ws = mkdtempSync(join(tmpdir(), "lab-aws-ws-"));
  mkdirSync(join(ws, "labs", lab.id, "terraform"), { recursive: true });
  writeFileSync(join(ws, "labs", lab.id, "lab.yaml"), stringify(lab));
  writeFileSync(join(ws, "labs", lab.id, "terraform", "main.tf"), "# test\n");
  const dir = mkdtempSync(join(tmpdir(), "lab-aws-parse-"));
  const event = join(dir, "event.json");
  const envFile = join(dir, "env");
  writeFileSync(event, JSON.stringify({ inputs: { action, payload: JSON.stringify(payload) } }));
  writeFileSync(envFile, "");
  const r = spawnSync(BASH, ["-eo", "pipefail", fwd(join(REPO, "infra", "ci", "lab-parse.sh"))], { encoding: "utf8", env: { ...process.env, LAB_PYTHON: PY ?? "", LAB_WORKFLOW_CLOUD: cloud, LAB_ACTION_INPUT: action, GITHUB_EVENT_PATH: fwd(event), GITHUB_ENV: fwd(envFile), GITHUB_WORKSPACE: fwd(ws) } });
  const env = {};
  for (const m of readFileSync(envFile, "utf8").matchAll(/^(\w+)<<(EOV_\w+)\n([^\n]*)\n\2$/gm)) env[m[1]] = m[3];
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), env };
}

test("Parse payload: an AWS deploy gets the AWS variables, tags and regions", { skip: skipParse }, () => {
  const r = parseRun("aws", PAYLOAD);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_CLOUD, "aws");
  assert.equal(r.env.TF_VAR_region, "eu-west-2");
  assert.equal(r.env.TF_VAR_gateway_cidr, "10.50.0.0/16");
  assert.deepEqual(JSON.parse(r.env.TF_VAR_tags), { "cloudlabs-lab": ID, "cloudlabs-session": PAYLOAD.session_id, project: "cloudlabs" });
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1");
  assert.equal(r.env.LAB_SECONDARY_REGION, "");
  assert.equal(r.env.TF_VAR_resource_group_name, undefined);
  assert.equal(r.env.LAB_DELETE_POLL_SECONDS, "30");
  assert.equal(r.env.LAB_UNBLOCK_VAULT_WAIT_SECONDS, "300");
  assert.equal(r.env.LAB_ENTRA, "false");
  assert.equal(r.env.LAB_DNS_LINK, "false");
  assert.equal(r.env.TF_VAR_name_prefix, "a03k3x9q");
  assert.equal(r.env.TF_VAR_address_space, "10.64.64.0/18");
  assert.equal(r.env.LAB_PEERING, "true");
  // gateway_cidr defaults to the VPN server's VPC when the payload leaves it out.
  const { gateway_cidr: _, ...noGateway } = PAYLOAD;
  const d = parseRun("aws", noGateway);
  assert.equal(d.status, 0, d.out);
  assert.equal(d.env.TF_VAR_gateway_cidr, "10.50.0.0/16");
});

test("Parse payload: a global lab also sweeps us-east-1 and us-west-2, and keeps its secondary region", { skip: skipParse }, () => {
  const g = { ...LAB, id: AWS_GLOBAL_LABS[0], version: 1 };
  const r = parseRun("aws", { ...PAYLOAD, lab_id: g.id, version: 1, name_prefix: "a09k3x9q", secondary_region: "eu-west-1" }, g);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1 us-west-2");
  assert.equal(r.env.TF_VAR_secondary_region, "eu-west-1");
});

test("ruling P5: a DNS lab's regions add us-east-1 only (Route 53 is listed there); its secondary is Ireland", { skip: skipParse }, () => {
  const d = { ...LAB, id: "saa-16-dr-pilot-light", version: 1 };
  const r = parseRun("aws", { ...PAYLOAD, lab_id: d.id, version: 1, name_prefix: "a16k3x9q", secondary_region: "eu-west-1" }, d);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1");
  assert.equal(r.env.TF_VAR_secondary_region, "eu-west-1");
});

test("Parse payload: an Azure run gains only LAB_CLOUD=azure", { skip: skipParse }, () => {
  const az = { id: "az104-08-vms", version: 1, connectivity: { peering: "optional", dns_link: false }, timing: { deploy_min: 5, destroy_min: 5 }, identity: { creates: [] } };
  const r = parseRun("azure", { ...PAYLOAD, lab_id: az.id, version: 1, region: "uksouth", name_prefix: "l08k3x9q", gateway_cidr: undefined }, az);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_CLOUD, "azure");
  assert.equal(r.env.TF_VAR_resource_group_name, "rg-lab-az104-08-vms");
  for (const k of ["LAB_REGIONS", "TF_VAR_gateway_cidr", "LAB_DELETE_POLL_SECONDS", "LAB_UNBLOCK_VAULT_WAIT_SECONDS"]) assert.equal(r.env[k], undefined, k);
  assert.deepEqual(JSON.parse(r.env.TF_VAR_tags), { project: "wg-admin-labs", lab: az.id, session: PAYLOAD.session_id });
});

// [what, workflow cloud, payload change, error pattern]
const PARSE_REFUSED = [
  ["an AWS lab on lab.yml", "azure", {}, /soa-03-auto-scaling is an AWS lab: it runs on lab-aws\.yml/],
  ["an Azure id on lab-aws.yml", "aws", { lab_id: "az104-08-vms" }, /az104-08-vms is an Azure lab: it runs on lab\.yml/],
  ["a region other than London", "aws", { region: "us-east-1" }, /region must be eu-west-2/],
  ["a secondary other than Ireland", "aws", { secondary_region: "eu-central-1" }, /secondary_region must be eu-west-1 or empty/],
  ["an Azure name prefix", "aws", { name_prefix: "l03k3x9q" }, /name_prefix is not a03 and 5 lowercase/],
  ["a gateway range inside the lab pool", "aws", { gateway_cidr: "10.64.0.0/16" }, /gateway_cidr must be an IPv4 range outside 10\.64\.0\.0\/13/],
  ["a gateway range that is not a range", "aws", { gateway_cidr: "10.50.0.1/16" }, /gateway_cidr must be an IPv4 range outside 10\.64\.0\.0\/13/],
  ["an AWS id over 30 characters", "aws", { lab_id: "soa-03-auto-scaling-and-more-words" }, /at most 30 characters/],
];
for (const [what, cloud, change, re] of PARSE_REFUSED) {
  test(`Parse payload refuses ${what}`, { skip: skipParse }, () => {
    const r = parseRun(cloud, { ...PAYLOAD, ...change });
    assert.notEqual(r.status, 0);
    assert.match(r.out, re);
  });
}

test("Parse payload refuses the other cloud's lab even for a destroy, and a lab.yaml whose cloud differs from its id", { skip: skipParse }, () => {
  const d = parseRun("azure", PAYLOAD, LAB, "destroy");
  assert.notEqual(d.status, 0);
  assert.match(d.out, /is an AWS lab: it runs on lab-aws\.yml/);
  const wrong = parseRun("aws", PAYLOAD, { ...LAB, cloud: "azure" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /lab\.yaml says cloud azure/);
});

test("aws-lab-creds.sh trades a GitHub token for a 3-hour session, masks it and exports it for the step", { skip }, () => {
  const w = world([
    { cmd: "curl", match: "audience=sts.amazonaws.com", out: '{"value":"gh-oidc-token"}' },
    { cmd: "aws", match: "^sts assume-role-with-web-identity", out: '{"AccessKeyId":"ASIAFAKE","SecretAccessKey":"fakesecret","SessionToken":"faketoken","Expiration":"2026-10-15T15:00:00Z"}' },
  ]);
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; source "${fwd(join(REPO, "infra/ci/aws-lab-creds.sh"))}" arn:aws:iam::123456789012:role/wg-admin-labs && echo "id=$AWS_ACCESS_KEY_ID region=$AWS_REGION s3=\${AWS_ENDPOINT_URL_S3:-none}"`], { encoding: "utf8", env: w.env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example?x=1", RUNNER_TEMP: fwd(w.dir), LAB_ID: ID, GITHUB_RUN_ID: "42", LAB_REGION: "eu-west-2", AWS_ENDPOINT_URL_S3: "https://r2.example" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::add-mask::ASIAFAKE/);
  assert.match(r.stdout, /::add-mask::fakesecret/);
  assert.match(r.stdout, /::add-mask::faketoken/);
  assert.match(r.stdout, /id=ASIAFAKE region=eu-west-2 s3=none/);
  const call = w.calls().find((c) => c.startsWith("aws sts"));
  assert.match(call, /--role-arn arn:aws:iam::123456789012:role\/wg-admin-labs/);
  assert.match(call, /--duration-seconds 10800/);
  assert.match(call, /--query Credentials/);
  assert.match(call, /--role-session-name lab-soa-03-auto-scaling-42/);
  assert.doesNotMatch(call, /gh-oidc-token/, "the token goes by file, never on the command line");
  w.cleanup();
});

test("aws-lab-creds.sh returns 1 with an error naming the role, never the ARN, when STS refuses; the shell carries on", { skip }, () => {
  const w = world([
    { cmd: "curl", match: "audience=sts.amazonaws.com", out: '{"value":"gh-oidc-token"}' },
    { cmd: "aws", match: "^sts assume-role-with-web-identity", code: 254, err: "An error occurred (AccessDenied) when calling the AssumeRoleWithWebIdentity operation: Not authorized" },
  ]);
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; source "${fwd(join(REPO, "infra/ci/aws-lab-creds.sh"))}" arn:aws:iam::123456789012:role/wg-admin-deploy 3600; echo "rc=$? id=\${AWS_ACCESS_KEY_ID:-none}"`], { encoding: "utf8", env: w.env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example?x=1", RUNNER_TEMP: fwd(w.dir), LAB_ID: ID, GITHUB_RUN_ID: "42", AWS_ACCESS_KEY_ID: "" }) });
  assert.match(r.stdout, /::error::GitHub or AWS STS refused the wg-admin-deploy session/);
  assert.match(r.stdout, /rc=1 id=none/);
  assert.doesNotMatch(r.stdout + r.stderr, /123456789012/);
  assert.match(w.calls().find((c) => c.startsWith("aws sts")), /--duration-seconds 3600/);
  w.cleanup();
});

const ARNS = JSON.stringify({ ResourceTagMappingList: [
  { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0aaa" },
  { ResourceARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/alb-a03k3x9q/50dc6c495c0c9188" },
  { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance-connect-endpoint/eice-0bbb" },
  { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0ccc" },
] });

test("the ready check waits for an initializing instance, passes active and available things, and fails an impaired one", { skip }, () => {
  const arns = ARNS;
  const ok = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: ['{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"initializing"},"SystemStatus":{"Status":"initializing"}}]}', '{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"ok"},"SystemStatus":{"Status":"ok"}}]}'] },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints", out: '{"InstanceConnectEndpoints":[{"State":"create-complete"}]}' },
  ]);
  const r = ok.run("infra/ci/lab-ready-aws.sh", [ID, "6"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(r.status, 0, r.out);
  assert.equal(ok.calls().filter((c) => c.startsWith("aws ec2 describe-instance-status")).length, 2, "polled until the checks passed");
  const bad = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: '{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"impaired"},"SystemStatus":{"Status":"ok"}}]}' },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints", out: '{"InstanceConnectEndpoints":[{"State":"create-complete"}]}' },
  ]);
  const b = bad.run("infra/ci/lab-ready-aws.sh", [ID, "6"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(b.status, 1);
  assert.match(b.out, /not ready: ec2:instance i-0aaa \(impaired\)/);
  assert.doesNotMatch(b.out, /123456789012/, "no account id in the log");
  // C16: a failed state ends the check at once, without waiting for the deadline.
  assert.equal(bad.calls().filter((c) => c.startsWith("aws ec2 describe-instance-status")).length, 1);
  ok.cleanup();
  bad.cleanup();
});

test("at the deadline a still-initializing instance passes with a warning, and anything else still pending fails", { skip }, () => {
  const init = '{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"initializing"},"SystemStatus":{"Status":"ok"}}]}';
  const eice = { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints", out: '{"InstanceConnectEndpoints":[{"State":"create-complete"}]}' };
  const warm = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: ARNS },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: init },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"active"}}]}' },
    eice,
  ]);
  const w = warm.run("infra/ci/lab-ready-aws.sh", [ID, "0"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(w.status, 0, w.out);
  assert.match(w.out, /::warning::.*i-0aaa/);
  const slow = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: ARNS },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: init },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"provisioning"}}]}' },
    eice,
  ]);
  const s = slow.run("infra/ci/lab-ready-aws.sh", [ID, "0"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(s.status, 1, s.out);
  assert.match(s.out, /not ready: elasticloadbalancing:loadbalancer app\/alb-a03k3x9q\/50dc6c495c0c9188 \(provisioning\)/);
  assert.doesNotMatch(s.out, /123456789012/);
  warm.cleanup();
  slow.cleanup();
});

// Review round 1: a quick redeploy must not wait on the last session's dead items, which the tagging API still lists.
test("the ready check counts deleted and not-found items as gone, and asks only about this session's items", { skip }, () => {
  const arns = JSON.stringify({ ResourceTagMappingList: [
    { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:natgateway/nat-0old" },
    { ResourceARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/alb-a03old00/50dc6c495c0c9188" },
    { ResourceARN: "arn:aws:eks:eu-west-2:123456789012:cluster/eks-a03old00" },
    { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0ccc" },
  ] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", out: '{"NatGateways":[{"State":"deleted"}]}' },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", code: 254, err: "An error occurred (LoadBalancerNotFound) when calling the DescribeLoadBalancers operation: One or more load balancers not found" },
    { cmd: "aws", match: "^eks describe-cluster", out: '{"cluster":{"status":"DELETING"}}' },
  ]);
  const r = w.run("infra/ci/lab-ready-aws.sh", [ID, "6"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0", SESSION_ID: "ls-20261015120000-cd34ef" });
  assert.equal(r.status, 0, r.out);
  assert.match(w.calls().find((c) => c.startsWith("aws resourcegroupstaggingapi")), /--tag-filters Key=cloudlabs-lab,Values=soa-03-auto-scaling Key=cloudlabs-session,Values=ls-20261015120000-cd34ef --region eu-west-2/);
  assert.equal(w.calls().filter((c) => c.startsWith("aws resourcegroupstaggingapi")).length, 1, "ready at the first poll");
  // Any other failure to ask is still pending, never ready.
  const down = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-nat-gateways", code: 254, err: "An error occurred (UnauthorizedOperation) when calling the DescribeNatGateways operation: no" },
  ]);
  const d = down.run("infra/ci/lab-ready-aws.sh", [ID, "0"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(d.status, 1, d.out);
  assert.match(d.out, /not ready: ec2:natgateway nat-0old \(could not ask AWS\)/);
  w.cleanup();
  down.cleanup();
});

test("the ready check and peering refuse a bad lab id with exit 2", { skip: BASH ? false : "no bash found" }, () => {
  const w = world([]);
  for (const id of ["../x", "soa-03-Auto", "soa-03-auto-scaling-and-more-words", ""]) {
    assert.equal(w.run("infra/ci/lab-ready-aws.sh", [id, "6"]).status, 2, id);
    assert.equal(w.run("infra/ci/lab-peer-aws.sh", ["peer", id]).status, 2, id);
  }
  assert.equal(w.run("infra/ci/lab-peer-aws.sh", ["sideways", ID]).status, 2);
  assert.equal(w.run("infra/ci/lab-ready-aws.sh", [ID, "six"]).status, 2);
  assert.equal(w.calls().filter((c) => c.startsWith("aws")).length, 0);
  w.cleanup();
});

const WG = { vpc: '{"Vpcs":[{"VpcId":"vpc-0wg"}]}', rt: '{"RouteTables":[{"RouteTableId":"rtb-0wg","Routes":[]}]}' };
test("peer asks the Worker, peers the lab VPC to vpc-wg, tags the connection and adds both routes", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "curl", match: '"phase":"end"', out: '{"message":"peered"}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0lab", out: '{"Vpcs":[{"VpcId":"vpc-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables --route-table-ids rtb-0lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab"}]}' },
    // The first matching rule answers: the wait for pcx-0lab before the search for the lab's existing connections.
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections.*pcx-0lab", out: '{"VpcPeeringConnections":[{"Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[]}' },
    { cmd: "aws", match: "^ec2 create-vpc-peering-connection", out: '{"VpcPeeringConnection":{"VpcPeeringConnectionId":"pcx-0lab"}}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", TF_VAR_gateway_cidr: "10.50.0.0/16", PEER_VPC_ID: "vpc-0lab", PEER_ROUTE_TABLE_IDS: '["rtb-0lab"]', LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls().filter((c) => c.startsWith("aws ec2 ") && !c.startsWith("aws ec2 describe"));
  assert.match(calls[0], /^aws ec2 create-vpc-peering-connection --vpc-id vpc-0lab --peer-vpc-id vpc-0wg .*Key=cloudlabs-lab,Value=soa-03-auto-scaling.*Key=Name,Value=lab-soa-03-auto-scaling-headend/);
  assert.match(calls[1], /^aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id pcx-0lab/);
  assert.ok(calls.some((c) => /^aws ec2 create-route --route-table-id rtb-0wg --destination-cidr-block 10\.64\.64\.0\/18 --vpc-peering-connection-id pcx-0lab/.test(c)));
  assert.ok(calls.some((c) => /^aws ec2 create-route --route-table-id rtb-0lab --destination-cidr-block 10\.50\.0\.0\/16 --vpc-peering-connection-id pcx-0lab/.test(c)));
  assert.match(w.calls().filter((c) => c.startsWith("curl")).at(-1), /"phase":"end","ok":true/);
  for (const c of w.calls().filter((x) => x.startsWith("aws "))) assert.match(c, /--region eu-west-2( --output json)?$/, c);
  w.cleanup();
});

test("peer replaces a route that already exists, and reuses the lab's active connection", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0lab", out: '{"Vpcs":[{"VpcId":"vpc-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables --route-table-ids rtb-0lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0old","Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 create-route --route-table-id rtb-0wg", code: 254, err: "An error occurred (RouteAlreadyExists) when calling the CreateRoute operation: The route identified by 10.64.64.0/18 already exists." },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", TF_VAR_gateway_cidr: "10.50.0.0/16", PEER_VPC_ID: "vpc-0lab", PEER_ROUTE_TABLE_IDS: '["rtb-0lab"]', LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (create|accept|replace)/.test(c));
  assert.ok(!writes.some((c) => c.startsWith("aws ec2 create-vpc-peering-connection")), "the active connection is reused");
  assert.ok(!writes.some((c) => c.startsWith("aws ec2 accept-vpc-peering-connection")), "an active connection needs no accepting");
  assert.ok(writes.includes("aws ec2 replace-route --route-table-id rtb-0wg --destination-cidr-block 10.64.64.0/18 --vpc-peering-connection-id pcx-0old --region eu-west-2"), writes.join("\n"));
  assert.match(w.calls().filter((c) => c.startsWith("curl")).at(-1), /"phase":"end","ok":true/);
  w.cleanup();
});

test("a peer run without outputs finds the lab's hub VPC and its route tables by tag (P8)", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:cloudlabs-peer,Values=hub", out: '{"Vpcs":[{"VpcId":"vpc-0hub"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0hub .*tag:cloudlabs-lab,Values=soa-03-auto-scaling", out: '{"Vpcs":[{"VpcId":"vpc-0hub"}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    { cmd: "aws", match: "^ec2 describe-route-tables.*vpc-id,Values=vpc-0hub", out: '{"RouteTables":[{"RouteTableId":"rtb-0hub"},{"RouteTableId":"rtb-0hub2"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections.*pcx-0hub", out: '{"VpcPeeringConnections":[{"Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[]}' },
    { cmd: "aws", match: "^ec2 create-vpc-peering-connection", out: '{"VpcPeeringConnection":{"VpcPeeringConnectionId":"pcx-0hub"}}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", TF_VAR_gateway_cidr: "10.50.0.0/16", LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (create|accept|replace)/.test(c));
  assert.match(writes[0], /^aws ec2 create-vpc-peering-connection --vpc-id vpc-0hub --peer-vpc-id vpc-0wg /);
  for (const rt of ["rtb-0hub", "rtb-0hub2"]) assert.ok(writes.some((c) => c.startsWith(`aws ec2 create-route --route-table-id ${rt} --destination-cidr-block 10.50.0.0/16 --vpc-peering-connection-id pcx-0hub`)), rt);
  w.cleanup();
});

// Controller ruling (review round 1): defence in depth for the VPN server.
test("peer refuses a VPC without the lab's tag, and writes nothing", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0other", out: '{"Vpcs":[]}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", PEER_VPC_ID: "vpc-0other", PEER_ROUTE_TABLE_IDS: '["rtb-0lab"]', LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /vpc-0other is not tagged cloudlabs-lab = soa-03-auto-scaling/);
  assert.match(w.calls().find((c) => c.startsWith("aws ec2 describe-vpcs --vpc-ids")), /--filters Name=tag:cloudlabs-lab,Values=soa-03-auto-scaling/);
  assert.deepEqual(w.calls().filter((c) => /^aws ec2 (create|accept|replace|delete)/.test(c)), []);
  assert.match(w.calls().filter((c) => c.startsWith("curl")).at(-1), /"phase":"end","ok":false/);
  w.cleanup();
});

test("peer routes only the route tables inside the lab VPC, reports the rest, and does not accept a provisioning connection", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0lab", out: '{"Vpcs":[{"VpcId":"vpc-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables --route-table-ids rtb-0lab rtb-0wg --filters Name=vpc-id,Values=vpc-0lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections --vpc-peering-connection-ids", out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0lab","Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0lab","Status":{"Code":"provisioning"}}]}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", TF_VAR_gateway_cidr: "10.50.0.0/16", PEER_VPC_ID: "vpc-0lab", PEER_ROUTE_TABLE_IDS: '["rtb-0lab","rtb-0wg"]', LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /rtb-0wg is not a route table of vpc-0lab/);
  const writes = w.calls().filter((c) => /^aws ec2 (create|accept|replace|delete)/.test(c));
  assert.ok(!writes.some((c) => c.startsWith("aws ec2 accept-vpc-peering-connection")), "a provisioning connection is already accepted");
  assert.deepEqual(writes.filter((c) => c.includes("10.50.0.0/16")), ["aws ec2 create-route --route-table-id rtb-0lab --destination-cidr-block 10.50.0.0/16 --vpc-peering-connection-id pcx-0lab --region eu-west-2"]);
  assert.match(w.calls().filter((c) => c.startsWith("curl")).at(-1), /"phase":"end","ok":false/);
  w.cleanup();
});

test("peer waits when the Worker says wait, and touches nothing", { skip }, () => {
  const w = world([{ cmd: "curl", match: '"phase":"begin"', out: '{"go":false,"reason":"the gateway is not running"}' }]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", PEER_VPC_ID: "vpc-0lab" });
  assert.equal(r.status, 0);
  assert.equal(w.calls().filter((c) => c.startsWith("aws")).length, 0);
  // No Worker at all: skipped, nothing touched.
  const none = world([]);
  const n = none.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "", PEER_VPC_ID: "vpc-0lab" });
  assert.equal(n.status, 0);
  assert.match(n.out, /no Worker/);
  assert.equal(none.calls().length, 0);
  w.cleanup();
  none.cleanup();
});

test("unpeer removes only this lab's route from rt-wg, the lab's routes, its connections and blackholes in the lab pool", { skip }, () => {
  const rt = { RouteTables: [{ RouteTableId: "rtb-0wg", Routes: [
    { DestinationCidrBlock: "10.64.64.0/18", VpcPeeringConnectionId: "pcx-0lab", State: "active" },
    { DestinationCidrBlock: "10.64.128.0/18", VpcPeeringConnectionId: "pcx-0other", State: "active" },
    { DestinationCidrBlock: "10.65.0.0/18", VpcPeeringConnectionId: "pcx-0gone", State: "blackhole" },
    { DestinationCidrBlock: "192.168.1.0/24", NetworkInterfaceId: "eni-0wg", State: "active" },
  ] }] };
  const w = world([
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: JSON.stringify(rt) },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0lab","Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:cloudlabs-lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab","Routes":[{"DestinationCidrBlock":"10.50.0.0/16","VpcPeeringConnectionId":"pcx-0lab"}]}]}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["unpeer", ID], { LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (delete|create|replace)/.test(c));
  assert.deepEqual(writes, [
    "aws ec2 delete-route --route-table-id rtb-0wg --destination-cidr-block 10.64.64.0/18 --region eu-west-2",
    "aws ec2 delete-route --route-table-id rtb-0lab --destination-cidr-block 10.50.0.0/16 --region eu-west-2",
    "aws ec2 delete-vpc-peering-connection --vpc-peering-connection-id pcx-0lab --region eu-west-2",
    "aws ec2 delete-route --route-table-id rtb-0wg --destination-cidr-block 10.65.0.0/18 --region eu-west-2",
  ]);
  w.cleanup();
});

test("unpeer removes only the headend peering and its routes, never a peering between the lab's own VPCs", { skip }, () => {
  const rt = { RouteTables: [{ RouteTableId: "rtb-0wg", Routes: [{ DestinationCidrBlock: "10.64.64.0/18", VpcPeeringConnectionId: "pcx-0head", State: "active" }] }] };
  const both = '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0head","Status":{"Code":"active"}},{"VpcPeeringConnectionId":"pcx-0own","Status":{"Code":"active"}}]}';
  const w = world([
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: JSON.stringify(rt) },
    { cmd: "aws", match: `^ec2 describe-vpc-peering-connections.*Name=tag:Name,Values=lab-${ID}-headend`, out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0head","Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: both },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:cloudlabs-lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab","Routes":[{"DestinationCidrBlock":"10.50.0.0/16","VpcPeeringConnectionId":"pcx-0head"},{"DestinationCidrBlock":"10.64.32.0/20","VpcPeeringConnectionId":"pcx-0own"}]}]}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["unpeer", ID], { LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (delete|create|replace)/.test(c));
  assert.deepEqual(writes, [
    "aws ec2 delete-route --route-table-id rtb-0wg --destination-cidr-block 10.64.64.0/18 --region eu-west-2",
    "aws ec2 delete-route --route-table-id rtb-0lab --destination-cidr-block 10.50.0.0/16 --region eu-west-2",
    "aws ec2 delete-vpc-peering-connection --vpc-peering-connection-id pcx-0head --region eu-west-2",
  ]);
  w.cleanup();
});

test("unpeer never fails the run, even when AWS refuses every call", { skip }, () => {
  const w = world([{ cmd: "aws", match: ".*", code: 254, err: "An error occurred (UnauthorizedOperation) when calling the operation: You are not authorized. User: arn:aws:sts::123456789012:assumed-role/x" }]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["unpeer", ID], { LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /123456789012/);
  w.cleanup();
});
