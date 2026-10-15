// aws-labs-iam.test.mjs
//
// Plain English: the AWS labs' IAM (AWS labs spec §7, rulings A19 and A29):
// the ABAC lists are made by the rule and pinned; every rendered role policy
// and the boundary fit AWS's size cap, the role holds at most 10 of them, and
// each §7.1 statement says what it must; the Worker user can only read; the
// bootstrap's simulator cases, quotas and cost tag steps behave. A small IAM
// evaluator (below) also replays the simulator cases offline, what Terraform
// does for a lab, and every AWS CLI call the lab workflow's scripts make, so a
// statement that would refuse the lab's own clean-up fails here, not at night.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { abacLists, foldWildcards, renderLabPolicies, policySize, POLICY_MAX, ROLE_POLICIES_MAX, LAB_SERVICES, ABAC_SERVICES } from "../lib/aws-lab-policies.mjs";
import { simulatorCases, simulatorProblems, quotaPlan, LAB_QUOTAS, runLabsBootstrap } from "../lib/aws-bootstrap-labs.mjs";

const url = (p) => new URL(`../../${p}`, import.meta.url);
const read = (p) => readFileSync(url(p), "utf8").replace(/\r\n/g, "\n");
const FILL = { account: "123456789012", vpcArns: ["arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0123456789abcdef0", "arn:aws:ec2:eu-west-1:123456789012:vpc/vpc-0fedcba9876543210"] };

// Ruling C19: the generated files are read inside the tests that need them, so the pure tests run without them.
const NOT_YET = "lab-abac.json not generated yet (Task 17)";
const generated = existsSync(url("infra/aws-bootstrap/lab-abac.json")) && existsSync(url("infra/aws-bootstrap/lab-policies.json"));
const skip = generated ? false : NOT_YET;
let cache;
function files() {
  if (!cache) {
    const ABAC = JSON.parse(read("infra/aws-bootstrap/lab-abac.json"));
    const POLICIES = JSON.parse(read("infra/aws-bootstrap/lab-policies.json"));
    const statements = POLICIES.role.flatMap((d) => d.Statement);
    cache = { ABAC, POLICIES, statements, sid: (s) => statements.find((x) => x.Sid === s) };
  }
  return cache;
}

// A small Service Authorization Reference, shaped as the real one (V).
const SAR = {
  ec2: {
    Name: "ec2",
    Resources: [
      { Name: "vpc", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "instance", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "volume", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "image", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
    ],
    Actions: [
      { Name: "CreateVpc", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "DeleteVpc", ActionConditionKeys: [], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "DescribeVpcs", ActionConditionKeys: [], Resources: [], Annotations: { Properties: { IsList: true } } },
      { Name: "AttachVolume", ActionConditionKeys: [], Resources: [{ Name: "instance" }, { Name: "volume" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "RunInstances", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "instance" }, { Name: "image" }, { Name: "volume" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "ModifyImageAttribute", ActionConditionKeys: [], Resources: [{ Name: "image" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "CreateTags", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsTaggingOnly: true } } },
    ],
  },
};

test("the ABAC rule: creates by RequestTag, changes only where every resource takes ResourceTag and none is AWS-owned (P16)", () => {
  const { create, change } = abacLists(SAR);
  assert.deepEqual(create.sort(), ["ec2:CreateVpc", "ec2:RunInstances"]);
  assert.deepEqual(change.sort(), ["ec2:AttachVolume", "ec2:DeleteVpc"]);
});

// The real reference puts EC2's request tags on the action's own resource list, per resource type (V 2026-10-15).
const W = (extra = {}) => ({ Annotations: { Properties: { IsWrite: true } }, ...extra });
const SAR2 = {
  ec2: {
    Name: "ec2",
    Resources: [
      { Name: "subnet", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:subnet/${SubnetId}"], ConditionKeys: ["aws:RequestTag/${TagKey}", "aws:ResourceTag/${TagKey}"] },
      { Name: "vpc", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:vpc/${VpcId}"], ConditionKeys: ["aws:RequestTag/${TagKey}", "aws:ResourceTag/${TagKey}"] },
      { Name: "instance", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:instance/${InstanceId}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "volume", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:volume/${VolumeId}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "network-interface", ARNFormats: ["arn:${Partition}:ec2:${Region}:${Account}:network-interface/${NetworkInterfaceId}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
    ],
    Actions: [
      W({ Name: "CreateSubnet", ActionConditionKeys: ["ec2:Region"], Resources: [{ Name: "subnet", ConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"] }, { Name: "vpc", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }] }),
      W({ Name: "RunInstances", ActionConditionKeys: ["ec2:Region"], Resources: [{ Name: "instance", ConditionKeys: ["aws:RequestTag/${TagKey}"] }, { Name: "network-interface", ConditionKeys: ["aws:RequestTag/${TagKey}"] }, { Name: "volume", ConditionKeys: ["aws:RequestTag/${TagKey}"] }, { Name: "subnet", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }] }),
      W({ Name: "DeleteSubnet", Resources: [{ Name: "subnet", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }] }),
      // Per-action keys win over the resource type's own: this one names the subnet without the tag key.
      W({ Name: "ModifySubnetThing", Resources: [{ Name: "subnet", ConditionKeys: ["ec2:SubnetID"] }] }),
    ],
  },
  cloudwatch: {
    Name: "cloudwatch",
    Resources: [{ Name: "dashboard", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }, { Name: "alarm", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }],
    Actions: [
      W({ Name: "PutDashboard", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "dashboard" }] }),
      W({ Name: "DeleteDashboards", Resources: [{ Name: "dashboard" }] }),
      W({ Name: "DeleteAlarms", Resources: [{ Name: "alarm" }] }),
      { Name: "UntagResource", ActionConditionKeys: ["aws:TagKeys"], Resources: [{ Name: "alarm" }], Annotations: { Properties: { IsTaggingOnly: true } } },
    ],
  },
  logs: {
    Name: "logs",
    Resources: [],
    Actions: [W({ Name: "DeleteQueryDefinition", Resources: [] })],
  },
  kms: {
    Name: "kms",
    Resources: [{ Name: "key", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }],
    Actions: [
      W({ Name: "ScheduleKeyDeletion", Resources: [{ Name: "key" }] }),
      W({ Name: "Decrypt", Resources: [{ Name: "key" }] }),
      W({ Name: "GenerateDataKeyWithoutPlaintext", Resources: [{ Name: "key" }] }),
      W({ Name: "CreateGrant", Resources: [{ Name: "key" }] }),
      // A read the reference gives the request tag: a read makes nothing, so it is never in the create list.
      { Name: "DescribeKey", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "key" }], Annotations: { Properties: { IsWrite: false } } },
    ],
  },
};

test("a create whose request tag sits on one resource type is refused only on that type; RunInstances only on instances and volumes", () => {
  const { create, change, createOn, untag } = abacLists(SAR2);
  assert.deepEqual(create, ["ec2:CreateSubnet", "ec2:RunInstances"]);
  assert.deepEqual(createOn, { "ec2:CreateSubnet": ["arn:aws:ec2:*:*:subnet/*"], "ec2:RunInstances": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"] });
  // No resource at all is never "every resource takes the tag"; what labs own by name (dashboards) is in neither list.
  // Using a key is not refused on the tag: AWS's own keys (aws/ebs, aws/s3, aws/rds) carry none and encrypt the labs' disks.
  assert.deepEqual(change, ["cloudwatch:DeleteAlarms", "ec2:DeleteSubnet", "kms:ScheduleKeyDeletion"]);
  assert.deepEqual(untag, ["cloudwatch:UntagResource"]);
});

test("wildcards fold only where every action they match is listed", () => {
  const all = ["ec2:CreateVpc", "ec2:CreateVpcEndpoint", "ec2:CreateVpcPeeringConnection", "ec2:CreateVolume"];
  assert.deepEqual(foldWildcards(["ec2:CreateVpc", "ec2:CreateVpcEndpoint", "ec2:CreateVpcPeeringConnection"], all), ["ec2:CreateVpc*"]);
  assert.deepEqual(foldWildcards(["ec2:CreateVpc", "ec2:CreateVpcEndpoint"], all).sort(), ["ec2:CreateVpc", "ec2:CreateVpcEndpoint"]);
});

test("a wildcard matches IAM's way, ignoring case", () => {
  const all = ["route53:CreateVpcAssociation", "route53:CreateVpcLink", "route53:CreateVPCAssociationAuthorization"];
  assert.deepEqual(foldWildcards(["route53:CreateVpcAssociation", "route53:CreateVpcLink"], all), ["route53:CreateVpcAssociation", "route53:CreateVpcLink"]);
});

test("lab-abac.json is the generator's, sorted, for the allow-listed services only, and pinned", { skip }, () => {
  const { ABAC } = files();
  assert.deepEqual(ABAC.services, [...ABAC_SERVICES]);
  for (const list of [ABAC.create, ABAC.change]) {
    assert.deepEqual(list, [...list].sort());
    assert.equal(new Set(list).size, list.length);
    for (const a of list) assert.ok(ABAC_SERVICES.includes(a.split(":")[0]), a);
  }
  assert.ok(ABAC.create.some((a) => /^ec2:(RunInstances|Run\*)$/.test(a)));
  for (const a of Object.keys(ABAC.createOn)) assert.ok(ABAC.create.includes(a), a);
  // Regenerating changes this pin on purpose: review the new lists, then update it.
  assert.equal(createHash("sha256").update(JSON.stringify({ create: ABAC.create, change: ABAC.change })).digest("hex"), "648c6fed3671f024bc379c5d31b892e0f2f586c8ddbb33188ec808791e4eb9aa");
});

test("lab-policies.json is what --render makes from lab-abac.json", { skip }, () => {
  const { ABAC, POLICIES } = files();
  assert.deepEqual(POLICIES, renderLabPolicies(ABAC));
});

test("every role policy and the boundary fit (A29), and the role holds at most 10", { skip }, () => {
  const { POLICIES } = files();
  assert.ok(POLICIES.role.length <= ROLE_POLICIES_MAX, `${POLICIES.role.length} role policies`);
  for (const [i, d] of POLICIES.role.entries()) assert.ok(policySize(d, FILL) < POLICY_MAX, `role policy ${i + 1}: ${policySize(d, FILL)}`);
  assert.ok(policySize(POLICIES.boundary, FILL) < POLICY_MAX);
});

test("each §7.1 statement says what it must", { skip }, () => {
  const { POLICIES, statements, sid } = files();
  for (const s of ["LabServices", "LabBuckets", "BucketList", "GlobalServices", "Identity", "LabRolesBounded", "LabRolesOther", "Lab07UsersBounded", "Lab07UsersOther", "PassLabRoles", "ServiceLinkedRoles", "DenyVpnServer", "DenyVpnTagRequest", "DenyVpnTagKeys", "DenyDefaultVpc", "DenyDefaultVpcChildren", "DenyAccountAndBilling", "DenyIamOutsideLab", "DenyBoundaryRemoval", "DenyOtherRoles", "DenyOtherRegions", "DenyGlobalRegionsForLabServices", "CreateNeedsLabTagRunInstances", "KeepLabTag"]) assert.ok(sid(s), s);
  assert.ok(statements.some((s) => /^CreateNeedsLabTag\d+$/.test(s.Sid)) && statements.some((s) => /^ChangeNeedsLabTag\d+$/.test(s.Sid)));
  assert.deepEqual(sid("DenyVpnServer").Condition, { StringEquals: { "aws:ResourceTag/wg-admin": "vpn" } });
  assert.deepEqual(sid("LabRolesBounded").Condition, { StringEquals: { "iam:PermissionsBoundary": "arn:aws:iam::__ACCOUNT__:policy/wg-admin-lab-boundary" } });
  assert.deepEqual(sid("LabServices").Condition, { StringEquals: { "aws:RequestedRegion": ["eu-west-2", "eu-west-1"] } });
  assert.deepEqual(sid("LabServices").Action, [...LAB_SERVICES.filter((s) => s !== "servicequotas").map((s) => `${s}:*`), "servicequotas:Get*", "servicequotas:List*"]);
  assert.equal(sid("DenyDefaultVpc").Resource, "__DEFAULT_VPC_ARNS__");
  assert.deepEqual(sid("Lab07UsersOther").Resource, "arn:aws:iam::__ACCOUNT__:user/cloudlabs-lab/lab-soa-07-*");
  for (const s of statements.filter((x) => x.Effect === "Allow")) for (const a of [].concat(s.Action ?? [])) assert.ok(a !== "*" && a !== "iam:*" && !/^iam:(Create|Delete|Put|Attach|Pass)/.test(a) || ["LabRolesBounded", "LabRolesOther", "Lab07UsersBounded", "Lab07UsersOther", "PassLabRoles", "ServiceLinkedRoles"].includes(s.Sid), `${s.Sid} allows ${a}`);
  const b = POLICIES.boundary.Statement;
  assert.ok(b.some((s) => s.Effect === "Deny" && s.Condition?.StringEquals?.["aws:ResourceTag/wg-admin"] === "vpn"));
  assert.ok(b.some((s) => s.Effect === "Deny" && [].concat(s.Action).includes("iam:PassRole")));
  // The global regions' deny never takes back what GlobalServices gives there.
  assert.ok(!sid("DenyGlobalRegionsForLabServices").Action.some((a) => /^(tag|wafv2):/.test(a)));
  // Lab roles and users may only be given the listed AWS managed policies or the lab's own.
  assert.match(JSON.stringify(sid("AttachListedPoliciesOnly")), /AmazonSSMManagedInstanceCore.*policy\/cloudlabs-lab\/lab-\*/);
});

test("labs.tf: wg-admin-labs trusts main only, for 3 hours, with every rendered policy attached", () => {
  const tf = read("infra/aws-bootstrap/labs.tf");
  assert.match(tf, /name\s+= "wg-admin-labs"\n\s+max_session_duration = 10800/);
  assert.match(tf, /"token\.actions\.githubusercontent\.com:sub" = "\$\{var\.github_sub_prefix\}:ref:refs\/heads\/main"/);
  assert.match(tf, /resource "aws_iam_policy" "lab_boundary" \{\n\s+name\s+= "wg-admin-lab-boundary"/);
  assert.match(tf, /count\s+= length\(aws_iam_policy\.labs\)/);
  // P13: aud and sub only.
  assert.doesNotMatch(tf, /job_workflow_ref/);
  // C11: the default VPC placeholder becomes a JSON array.
  assert.match(tf, /vpc_arns_json\s+= jsonencode\(length\(local\.default_vpc_arns\) > 0 \? local\.default_vpc_arns : \[/);
  assert.match(read("infra/aws-bootstrap/outputs.tf"), /output "labs_role_arn" \{\n\s+value = aws_iam_role\.labs\.arn/);
});

test("the Worker user may read lab things in both lab regions, and change nothing", () => {
  const main = read("infra/aws-bootstrap/main.tf");
  for (const s of ["LabsLook", "LabsGlobalLook"]) assert.match(main, new RegExp(`Sid\\s+= "${s}"`));
  assert.match(main, /"aws:RequestedRegion" = \[var\.region, "eu-west-1"\]/);
  /** One statement: from its Sid to the next Sid (or the end), as aws-infra.test.mjs reads them. */
  const block = (s) => {
    const i = main.search(new RegExp(`Sid\\s+= "${s}"`));
    const rest = main.slice(i + 1);
    const j = rest.search(/Sid\s+=\s+"/);
    return j < 0 ? rest : rest.slice(0, j);
  };
  for (const s of ["LabsLook", "LabsGlobalLook"]) assert.doesNotMatch(block(s), /:(Create|Delete|Modify|Put|Update|Start|Stop|Terminate|Run|Attach|Detach|Tag|Untag)/);
  // Task 7's reads: every one is granted.
  for (const a of ["iam:ListRoles", "iam:ListInstanceProfiles", "iam:ListPolicies", "iam:ListUsers", "iam:GetRole", "iam:GetPolicy", "ce:ListCostAllocationTags"]) assert.ok(block("LabsGlobalLook").includes(`"${a}"`), a);
  for (const a of ["config:DescribeConfigurationRecorders", "cloudwatch:ListDashboards", "ec2:Describe*", "elasticloadbalancing:Describe*"]) assert.ok(block("LabsLook").includes(`"${a}"`), a);
  assert.match(block("Look"), /"aws:RequestedRegion" = \[var\.region, "eu-west-1"\]/);
});

test("the simulator cases are the eight of A19, and a wrong answer is a problem", () => {
  const cases = simulatorCases("123456789012");
  assert.deepEqual(cases.map((c) => [c.name, c.want]), [["tagged VPC", "allowed"], ["bounded lab role", "allowed"], ["untagged VPC", "denied"], ["the VPN server", "denied"], ["role without the boundary", "denied"], ["role outside the path", "denied"], ["access key", "denied"], ["a third region", "denied"]]);
  const ok = cases.map((c) => ({ name: c.name, decision: c.want === "allowed" ? "allowed" : "explicitDeny" }));
  assert.deepEqual(simulatorProblems(ok, cases), []);
  assert.deepEqual(simulatorProblems([{ ...ok[0], decision: "implicitDeny" }, ...ok.slice(1)], cases), ["tagged VPC: wanted allowed, AWS said implicitDeny"]);
  assert.deepEqual(simulatorProblems(ok.slice(1), cases), ["tagged VPC: AWS gave no answer"]);
});

test("quotas: VPCs and EIPs always raised to 20 and 10, vCPUs only if below 32, pending requests left alone", () => {
  assert.deepEqual(LAB_QUOTAS.slice(0, 3).map((q) => [q.service, q.code, q.want, q.raise]), [["vpc", "L-F678F1CE", 20, "always"], ["ec2", "L-0263D0A3", 10, "always"], ["ec2", "L-1216C47A", 32, "if-below"]]);
  const plan = quotaPlan([
    { service: "vpc", code: "L-F678F1CE", region: "eu-west-2", value: 5, pending: false },
    { service: "vpc", code: "L-F678F1CE", region: "eu-west-1", value: 5, pending: true },
    { service: "ec2", code: "L-1216C47A", region: "eu-west-2", value: 64, pending: false },
    { service: "ec2", code: "L-0263D0A3", region: "eu-west-2", value: 10, pending: false },
  ]);
  assert.deepEqual(plan, [{ service: "vpc", code: "L-F678F1CE", region: "eu-west-2", to: 20 }]);
  // Unread: an "always" quota is asked for anyway; an "if-below" one is left alone.
  assert.deepEqual(quotaPlan([
    { service: "ec2", code: "L-0263D0A3", region: "eu-west-1", value: null, pending: false },
    { service: "ec2", code: "L-1216C47A", region: "eu-west-1", value: null, pending: false },
  ]), [{ service: "ec2", code: "L-0263D0A3", region: "eu-west-1", to: 10 }]);
});

// ── The bootstrap's --labs steps, with a fake aws ─────────────────────────

/** The simulator answering as A19 wants: the case with this action, resource and context. */
const asWanted = (opt) => {
  const c = simulatorCases("123456789012").find((x) => x.action === opt("--action-names") && x.resource === opt("--resource-arns") && JSON.stringify(x.context.map((e) => ({ ContextKeyName: e.key, ContextKeyValues: e.values, ContextKeyType: e.type }))) === (x.context.length ? opt("--context-entries") : JSON.stringify([])));
  return c?.want === "allowed" ? "allowed" : "explicitDeny";
};
/** A fake command runner: answers by the aws command, records every call. */
function fakeAws({ decide = asWanted, quotas = {}, pending = [], costTag = "Inactive", eiceCode = "L-ABCD1234", failQuotaReads = false } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    const opt = (k) => args[args.indexOf(k) + 1];
    const ok = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
    if (a.startsWith("iam simulate-principal-policy")) return ok({ EvaluationResults: [{ EvalActionName: opt("--action-names"), EvalDecision: decide(opt) }] });
    if (a.startsWith("service-quotas list-service-quotas")) return ok({ Quotas: eiceCode ? [{ QuotaCode: eiceCode, QuotaName: "Instance Connect Endpoints per Region" }] : [] });
    if (a.startsWith("service-quotas get-service-quota") || a.startsWith("service-quotas get-aws-default-service-quota")) {
      if (failQuotaReads) return { status: 255, stdout: "", stderr: "An error occurred (AccessDenied)" };
      const v = quotas[`${opt("--quota-code")} ${opt("--region")}`];
      return v === undefined ? { status: 254, stdout: "", stderr: "An error occurred (NoSuchResourceException)" } : ok({ Quota: { Value: v } });
    }
    if (a.startsWith("service-quotas list-requested-service-quota-change-history-by-quota")) return ok({ RequestedQuotas: pending.includes(`${opt("--quota-code")} ${opt("--region")}`) ? [{ Status: "CASE_OPENED" }] : [{ Status: "APPROVED" }] });
    if (a.startsWith("service-quotas request-service-quota-increase")) return ok({ RequestedQuota: { Status: "PENDING" } });
    if (a.startsWith("ce list-cost-allocation-tags")) return ok({ CostAllocationTags: costTag ? [{ TagKey: "cloudlabs-lab", Status: costTag }] : [] });
    if (a.startsWith("ce update-cost-allocation-tags-status")) return ok({ Errors: [] });
    return { status: 1, stdout: "", stderr: `unexpected ${a}` };
  };
  return { run, calls };
}
const O = { account: "123456789012", roleArn: "arn:aws:iam::123456789012:role/wg-admin-labs" };

test("--labs: every simulator case is asked of the role, quotas below target are raised, an inactive cost tag is activated", async () => {
  const log = [];
  const { run, calls } = fakeAws({ quotas: { "L-F678F1CE eu-west-2": 5, "L-F678F1CE eu-west-1": 20, "L-0263D0A3 eu-west-2": 5, "L-0263D0A3 eu-west-1": 5, "L-1216C47A eu-west-2": 32, "L-1216C47A eu-west-1": 16, "L-ABCD1234 eu-west-2": 5, "L-ABCD1234 eu-west-1": 10 }, pending: ["L-0263D0A3 eu-west-1"] });
  const r = await runLabsBootstrap(run, { ...O, log: (s) => log.push(s) });
  assert.equal(r.ok, true);
  const sims = calls.filter((c) => c[2] === "simulate-principal-policy");
  assert.equal(sims.length, 8);
  for (const c of sims) assert.equal(c[c.indexOf("--policy-source-arn") + 1], O.roleArn);
  const tagged = sims[0];
  assert.deepEqual(JSON.parse(tagged[tagged.indexOf("--context-entries") + 1]), [
    { ContextKeyName: "aws:RequestedRegion", ContextKeyValues: ["eu-west-2"], ContextKeyType: "string" },
    { ContextKeyName: "aws:RequestTag/cloudlabs-lab", ContextKeyValues: ["soa-01-x"], ContextKeyType: "string" },
    { ContextKeyName: "aws:TagKeys", ContextKeyValues: ["cloudlabs-lab"], ContextKeyType: "stringList" },
  ]);
  const raised = calls.filter((c) => c[2] === "request-service-quota-increase").map((c) => [c[c.indexOf("--quota-code") + 1], c[c.indexOf("--region") + 1], c[c.indexOf("--desired-value") + 1]]);
  assert.deepEqual(raised, [["L-F678F1CE", "eu-west-2", "20"], ["L-0263D0A3", "eu-west-2", "10"], ["L-1216C47A", "eu-west-1", "32"], ["L-ABCD1234", "eu-west-2", "10"]]);
  assert.ok(calls.some((c) => c.join(" ") === "aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=cloudlabs-lab,Status=Active --region us-east-1"));
  assert.ok(log.includes("Cost tag cloudlabs-lab: activated"));
  assert.ok(log.some((s) => /Instance Connect Endpoints per Region.*L-ABCD1234/.test(s)));
  // Names only: no ARN, no account id.
  assert.ok(!log.some((s) => s.includes("123456789012")), log.join("\n"));
});

test("--labs: a simulator answer that differs fails loudly; an active or unseen cost tag is only reported", async () => {
  const log = [];
  const { run, calls } = fakeAws({ decide: () => "allowed", costTag: "Active", quotas: {} });
  // Every case answers "allowed": the six refusals are problems.
  const r = await runLabsBootstrap(run, { ...O, log: (s) => log.push(s) });
  assert.equal(r.ok, false);
  assert.ok(log.some((s) => /untagged VPC: wanted denied, AWS said allowed/.test(s)));
  assert.ok(log.includes("Cost tag cloudlabs-lab: active"));
  assert.ok(!calls.some((c) => c[2] === "update-cost-allocation-tags-status"));
  const none = fakeAws({ costTag: null, eiceCode: null, failQuotaReads: true });
  const log2 = [];
  await runLabsBootstrap(none.run, { ...O, log: (s) => log2.push(s) });
  assert.ok(log2.some((s) => /not seen in billing yet/.test(s)));
  assert.ok(log2.some((s) => /Instance Connect Endpoints per Region: not found/.test(s)));
  // Unread quotas: "always" ones are still asked for, "if-below" ones are not.
  assert.deepEqual([...new Set(none.calls.filter((c) => c[2] === "request-service-quota-increase").map((c) => c[c.indexOf("--quota-code") + 1]))], ["L-F678F1CE", "L-0263D0A3"]);
});

// ── An IAM evaluator, enough for these policies ──────────────────────────

const lc = (s) => String(s).toLowerCase();
const glob = (pattern, value, caseless) => {
  const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, caseless ? "i" : "");
  return re.test(String(value));
};
const list = (v) => [].concat(v);
function fill(doc) {
  return JSON.parse(JSON.stringify(doc).split("__ACCOUNT__").join(FILL.account).split('"__DEFAULT_VPC_ARNS__"').join(JSON.stringify(FILL.vpcArns)));
}
function condHolds(cond = {}, ctx) {
  for (const [op, keys] of Object.entries(cond)) {
    for (const [k, want] of Object.entries(keys)) {
      const have = ctx[k];
      const ws = list(want).map(String);
      const hs = have === undefined ? [] : list(have).map(String);
      let ok;
      switch (op) {
        case "StringEquals": ok = have !== undefined && hs.some((h) => ws.includes(h)); break;
        case "StringNotEquals": ok = have === undefined || !hs.some((h) => ws.includes(h)); break;
        case "Null": ok = (want === "true") === (have === undefined); break;
        case "ForAnyValue:StringEquals": ok = hs.some((h) => ws.includes(h)); break;
        case "ArnEquals": case "ArnLike": ok = have !== undefined && hs.some((h) => ws.some((w) => glob(w, h))); break;
        case "ArnNotLike": ok = have === undefined || !hs.some((h) => ws.some((w) => glob(w, h))); break;
        default: throw new Error(`the evaluator does not know ${op}`);
      }
      if (!ok) return false;
    }
  }
  return true;
}
function matches(s, { action, resource, ctx }) {
  const a = s.Action !== undefined ? list(s.Action).some((p) => glob(p, action, true)) : !list(s.NotAction).some((p) => glob(p, action, true));
  const r = s.Resource !== undefined ? list(s.Resource).some((p) => glob(p, resource)) : !list(s.NotResource).some((p) => glob(p, resource));
  return a && r && condHolds(s.Condition, ctx);
}
/** "allowed", "explicitDeny" or "implicitDeny" for one request, as IAM decides it for a role with these policies. */
function decide(docs, req) {
  const st = docs.flatMap((d) => fill(d).Statement);
  if (st.some((s) => s.Effect === "Deny" && matches(s, req))) return "explicitDeny";
  return st.some((s) => s.Effect === "Allow" && matches(s, req)) ? "allowed" : "implicitDeny";
}
const ctxOf = (c) => Object.fromEntries(c.context.map((e) => [e.key, e.type === "stringList" ? e.values : e.values[0]]));

test("the evaluator, on the rendered policies, answers each simulator case as AWS must", { skip }, () => {
  const { POLICIES } = files();
  for (const c of simulatorCases(FILL.account)) {
    const d = decide(POLICIES.role, { action: c.action, resource: c.resource, ctx: ctxOf(c) });
    assert.equal(d === "allowed" ? "allowed" : "denied", c.want, `${c.name}: ${d}`);
  }
});

const A = FILL.account;
const LAB = { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/cloudlabs-lab": "soa-01-x" };
const NEW = { "aws:RequestedRegion": "eu-west-2", "aws:RequestTag/cloudlabs-lab": "soa-01-x", "aws:TagKeys": ["cloudlabs-lab", "Name"] };
const BOUNDED = { "iam:PermissionsBoundary": `arn:aws:iam::${A}:policy/wg-admin-lab-boundary` };

test("what Terraform does for a lab is allowed: tagged creates on the new item only, untaggable items by name, bounded roles", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const denied = (action, resource, ctx) => assert.notEqual(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  // A subnet: the new subnet carries the request tag, its VPC (already there) the resource tag.
  allowed("ec2:CreateSubnet", `arn:aws:ec2:eu-west-2:${A}:subnet/*`, NEW);
  allowed("ec2:CreateSubnet", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0lab`, { ...LAB, "aws:RequestTag/cloudlabs-lab": "soa-01-x" });
  allowed("ec2:CreateSecurityGroup", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0lab`, LAB);
  // An instance: tags on the instance and its volumes; the image, subnet and network interface carry no request tag.
  allowed("ec2:RunInstances", `arn:aws:ec2:eu-west-2:${A}:instance/*`, NEW);
  allowed("ec2:RunInstances", `arn:aws:ec2:eu-west-2:${A}:volume/*`, NEW);
  for (const r of [`arn:aws:ec2:eu-west-2::image/ami-0abc`, `arn:aws:ec2:eu-west-2:${A}:subnet/subnet-0lab`, `arn:aws:ec2:eu-west-2:${A}:network-interface/*`, `arn:aws:ec2:eu-west-2:${A}:security-group/sg-0lab`]) allowed("ec2:RunInstances", r, { "aws:RequestedRegion": "eu-west-2" });
  denied("ec2:RunInstances", `arn:aws:ec2:eu-west-2:${A}:instance/*`, { "aws:RequestedRegion": "eu-west-2" });
  // The untaggable types a lab names lab-<id>-* (lab-scope-aws.mjs UNTAGGABLE): made and removed without a tag.
  for (const a of ["cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards", "config:PutConfigurationRecorder", "config:StartConfigurationRecorder", "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:PutDeliveryChannel", "config:DeleteDeliveryChannel", "logs:PutQueryDefinition", "logs:DeleteQueryDefinition", "kms:CreateAlias", "kms:DeleteAlias", "ssm:RegisterPatchBaselineForPatchGroup"]) {
    allowed(a, `arn:aws:${a.split(":")[0]}:eu-west-2:${A}:lab-soa-01-x-thing`, { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/cloudlabs-lab": a.startsWith("ssm:") ? "soa-01-x" : undefined });
  }
  // Changes to anything without the lab tag are refused; so is changing the default VPC, even tagged.
  denied("ec2:DeleteSubnet", `arn:aws:ec2:eu-west-2:${A}:subnet/subnet-0other`, { "aws:RequestedRegion": "eu-west-2" });
  denied("ec2:CreateSubnet", FILL.vpcArns[0], { ...LAB, "aws:RequestTag/cloudlabs-lab": "soa-01-x" });
  denied("ec2:CreateSecurityGroup", `arn:aws:ec2:eu-west-2:${A}:security-group/*`, { ...NEW, "ec2:Vpc": FILL.vpcArns[1] });
  // An encrypted disk: EC2 uses AWS's own (untagged) aws/ebs key as the caller.
  for (const a of ["kms:CreateGrant", "kms:GenerateDataKeyWithoutPlaintext", "kms:Decrypt", "kms:DescribeKey"]) allowed(a, `arn:aws:kms:eu-west-2:${A}:key/0abc`, { "aws:RequestedRegion": "eu-west-2" });
  denied("kms:ScheduleKeyDeletion", `arn:aws:kms:eu-west-2:${A}:key/0abc`, { "aws:RequestedRegion": "eu-west-2" });
  // A read never needs a tag, even where the reference lists the request tag for it.
  for (const a of ["access-analyzer:GetAnalyzer", "ecr:ListTagsForResource"]) allowed(a, "*", { "aws:RequestedRegion": "eu-west-2" });
  // Removing the lab's own tag, or tagging with the server's key, is refused.
  denied("ec2:DeleteTags", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0lab`, { ...LAB, "aws:TagKeys": ["cloudlabs-lab"] });
  denied("ec2:CreateTags", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0lab`, { ...LAB, "aws:RequestTag/wg-admin": "vpn", "aws:TagKeys": ["wg-admin"] });
  // IAM: a bounded role at the path, one of the listed managed policies or the lab's own, an instance profile.
  const role = `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-01-x-vm`;
  allowed("iam:CreateRole", role, BOUNDED);
  allowed("iam:AttachRolePolicy", role, { ...BOUNDED, "iam:PolicyARN": "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" });
  allowed("iam:AttachRolePolicy", role, { ...BOUNDED, "iam:PolicyARN": `arn:aws:iam::${A}:policy/cloudlabs-lab/lab-soa-01-x-logs` });
  denied("iam:AttachRolePolicy", role, { ...BOUNDED, "iam:PolicyARN": "arn:aws:iam::aws:policy/AdministratorAccess" });
  allowed("iam:PassRole", role, { "iam:PassedToService": "ec2.amazonaws.com" });
  denied("iam:PassRole", role, { "iam:PassedToService": "iam.amazonaws.com" });
  allowed("iam:CreateInstanceProfile", `arn:aws:iam::${A}:instance-profile/cloudlabs-lab/lab-soa-01-x-vm`, {});
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`, { "iam:AWSServiceName": "autoscaling.amazonaws.com" });
  denied("iam:CreateUser", `arn:aws:iam::${A}:user/cloudlabs-lab/lab-soa-01-x-ann`, BOUNDED);
  allowed("iam:CreateUser", `arn:aws:iam::${A}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, BOUNDED);
  // S3 by name; the global services in their regions only; GetResources there too.
  allowed("s3:CreateBucket", "arn:aws:s3:::cloudlabs-a01abcde-logs", { "aws:RequestedRegion": "eu-west-2" });
  denied("s3:CreateBucket", "arn:aws:s3:::someone-else", { "aws:RequestedRegion": "eu-west-2" });
  allowed("cloudfront:CreateDistribution", "*", { "aws:RequestedRegion": "us-east-1" });
  allowed("tag:GetResources", "*", { "aws:RequestedRegion": "us-east-1" });
  denied("ec2:DescribeVpcs", "*", { "aws:RequestedRegion": "us-east-1" });
  denied("ec2:DescribeVpcs", "*", { "aws:RequestedRegion": "eu-central-1" });
});

// ── Every AWS CLI call the lab workflow's scripts make, as the role ──────

/** The CLI's service names that are not IAM's, and the commands whose IAM action is not their own name. */
const CLI_SERVICE = { elbv2: "elasticloadbalancing", configservice: "config", resourcegroupstaggingapi: "tag", s3api: "s3" };
const CLI_ACTION = {
  "s3api head-bucket": ["s3:ListBucket"],
  "s3api list-object-versions": ["s3:ListBucketVersions"],
  "s3api delete-objects": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
  "s3api get-object-lock-configuration": ["s3:GetBucketObjectLockConfiguration"],
};
const SERVICES_RE = /(?:^|[\s(])(ec2|elbv2|rds|autoscaling|events|configservice|s3api|sns|logs|cloudwatch|ssm|backup|resource-groups|kms|iam|resourcegroupstaggingapi|dynamodb|network-firewall|cloudformation|elasticache|eks|ecs|cloudfront|globalaccelerator|vpc-lattice|route53resolver)\s+"?([a-z0-9]+-[a-z0-9$-]+)"?/g;
/** Every "<service> <command>" an aws call names in a script (comments left out), with the region it names. */
function cliCalls(path) {
  const out = [];
  for (const line of read(path).split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(SERVICES_RE)) {
      const cmds = m[2].includes("$dir") ? [m[2].replace("$dir", "ingress"), m[2].replace("$dir", "egress")] : [m[2]];
      const region = /--region (us-east-1|us-west-2)\b/.exec(line)?.[1];
      for (const c of cmds) out.push({ cli: `${m[1]} ${c}`, region });
    }
  }
  return out;
}
const camel = (c) => c.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
/** The IAM request one CLI call makes, on a lab item (tagged, or one of the untaggable named types). */
function requestsOf({ cli, region }) {
  const [svc, cmd] = cli.split(" ");
  const actions = CLI_ACTION[cli] ?? [`${CLI_SERVICE[svc] ?? svc}:${camel(cmd)}`];
  const read = /^(describe|list|get|head)-/.test(cmd);
  const named = /dashboard|configuration-recorder|delivery-channel|query-definition|alias/.test(cmd);
  if (svc === "iam") {
    const what = /instance-profile/.test(cmd) ? "instance-profile" : /policy-version|^(get|delete)-policy$/.test(cmd) ? "policy" : /user|login-profile/.test(cmd) ? "user" : /role/.test(cmd) ? "role" : null;
    const name = what === "user" ? "lab-soa-07-iam-kms-ann" : "lab-soa-01-x-vm";
    const resource = what && !/^list-(roles|instance-profiles|policies|users)$/.test(cmd) ? `arn:aws:iam::${A}:${what}/cloudlabs-lab/${name}` : "*";
    return actions.map((action) => ({ action, resource, ctx: { "aws:RequestedRegion": "us-east-1", ...(what === "role" || what === "user" ? BOUNDED : {}) } }));
  }
  const r = region ?? "eu-west-2";
  const resource = svc === "s3api" ? "arn:aws:s3:::cloudlabs-a01abcde-logs" : `arn:aws:${CLI_SERVICE[svc] ?? svc}:${r}:${A}:lab-item/x`;
  // A read must not need the lab's tag; a write is on a tagged item, or a named one that cannot carry tags.
  const ctx = { "aws:RequestedRegion": r, ...(read || named ? {} : { "aws:ResourceTag/cloudlabs-lab": "soa-01-x" }) };
  return actions.map((action) => ({ action, resource, ctx }));
}

test("every AWS CLI call in Unblock, the safety net, Verify clean and the ready check is allowed to wg-admin-labs", { skip }, () => {
  const { POLICIES } = files();
  const scripts = ["infra/ci/lab-unblock-aws.sh", "infra/ci/lab-aws-safety-net.sh", "infra/ci/lab-ready-aws.sh"];
  const calls = scripts.flatMap((p) => cliCalls(p).map((c) => ({ ...c, p })));
  // The extraction found the calls (a script that stops naming them would make this test vacuous).
  assert.ok(calls.length > 90, `${calls.length} calls`);
  for (const must of ["iam delete-role", "configservice stop-configuration-recorder", "cloudwatch delete-dashboards", "ec2 revoke-security-group-egress", "resourcegroupstaggingapi get-resources", "cloudfront get-distribution", "s3api delete-objects"]) assert.ok(calls.some((c) => c.cli === must), must);
  const refused = [];
  for (const c of calls) for (const req of requestsOf(c)) {
    const d = decide(POLICIES.role, req);
    if (d !== "allowed") refused.push(`${c.p}: ${c.cli} -> ${req.action} on ${req.resource}: ${d}`);
  }
  assert.deepEqual([...new Set(refused)], []);
});

test("the peer step's calls stay inside wg-admin-deploy's own policy (unchanged; ruling A25)", () => {
  const calls = new Set(cliCalls("infra/ci/lab-peer-aws.sh").map((c) => c.cli));
  assert.deepEqual([...calls].sort(), ["ec2 accept-vpc-peering-connection", "ec2 create-route", "ec2 create-vpc-peering-connection", "ec2 delete-route", "ec2 delete-vpc-peering-connection", "ec2 describe-route-tables", "ec2 describe-vpc-peering-connections", "ec2 describe-vpcs", "ec2 replace-route"]);
  // ec2:* in the region; none of them is in the deploy role's tag-scoped deny.
  const main = read("infra/aws-bootstrap/main.tf");
  const deny = main.slice(main.indexOf('Sid    = "OnlyWgAdminThings"'), main.indexOf("aws_iam_user\" \"worker\""));
  for (const c of calls) assert.ok(!deny.includes(`"ec2:${camel(c.split(" ")[1])}"`), c);
});

test("A29's fall-back: lists too long for 10 policies become per-service Delete/Modify/Update/Terminate wildcards", () => {
  const many = Array.from({ length: 4000 }, (_, i) => `ec2:DoSomethingQuiteLongNumber${String(i).padStart(4, "0")}`);
  const r = renderLabPolicies({ services: ABAC_SERVICES, create: ["ec2:CreateVpc", "ec2:RunInstances"], change: many, createOn: { "ec2:RunInstances": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"] }, untag: ["ec2:DeleteTags"] });
  assert.ok(r.role.length <= ROLE_POLICIES_MAX);
  const change = r.role.flatMap((d) => d.Statement).filter((s) => /^ChangeNeedsLabTag\d+$/.test(s.Sid)).flatMap((s) => s.Action);
  assert.ok(change.includes("ec2:Delete*") && change.includes("rds:Modify*") && change.includes("lambda:Update*") && change.includes("ec2:Terminate*"));
  assert.ok(!change.some((a) => /DoSomething/.test(a)));
  // Even then, the services of the untaggable named types stay out (their items carry no tag).
  assert.ok(!change.some((a) => /^(cloudwatch|config|logs|kms):/.test(a)), change.join(" "));
  for (const d of r.role) assert.ok(policySize(d, FILL) < POLICY_MAX);
});
