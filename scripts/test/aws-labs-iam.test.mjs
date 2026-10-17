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
import { abacLists, foldWildcards, renderLabPolicies, policySize, fillPolicy, POLICY_MAX, ROLE_POLICIES_MAX, LAB_SERVICES, ABAC_SERVICES, SERVICE_LINKED, NON_CREATE_VERB, CHANGE_TAG_EXEMPT, POLICY_PACK, HTTP_VERB_RULES, NAMED_TABLES, EKS_LB_TAG, CREATE_TAG_EXEMPT } from "../lib/aws-lab-policies.mjs";
import { simulatorCases, boundaryCases, simulatorProblems, quotaPlan, LAB_QUOTAS, runLabsBootstrap } from "../lib/aws-bootstrap-labs.mjs";

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

test("ruling A82: moving a subnet's ACL association is in no change list (AWS asks about the untagged default ACL being replaced)", () => {
  const sar = { ec2: { Name: "ec2", Resources: [{ Name: "network-acl", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }], Actions: [
    W({ Name: "ReplaceNetworkAclAssociation", Resources: [{ Name: "network-acl" }] }),
    W({ Name: "ReplaceNetworkAclEntry", Resources: [{ Name: "network-acl" }] }),
  ] } };
  // Without the exemption the two would fold into ec2:ReplaceNetwork*, which still refuses the association.
  assert.deepEqual(abacLists(sar).change, ["ec2:ReplaceNetworkAclEntry"]);
  assert.ok(CHANGE_TAG_EXEMPT.includes("ec2:ReplaceNetworkAclAssociation"));
});

test("ruling A82: a change-list entry that names or covers an exempt action fails the render", () => {
  const abac = { services: [...ABAC_SERVICES], create: [], createOn: {}, change: ["ec2:ReplaceNetwork*"], untag: [] };
  assert.throws(() => renderLabPolicies(abac), /ec2:ReplaceNetwork\*.*A82/);
  assert.throws(() => renderLabPolicies({ ...abac, change: ["ec2:ReplaceNetworkAclAssociation"] }), /A82/);
});

test("ruling P22: deleting a network interface is in no change list (EFS's DeleteMountTarget asks about its untagged ENI as the caller)", () => {
  const sar = { ec2: { Name: "ec2", Resources: [{ Name: "network-interface", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }], Actions: [
    W({ Name: "DeleteNetworkInterface", Resources: [{ Name: "network-interface" }] }),
    W({ Name: "DeleteNetworkAcl", Resources: [{ Name: "network-interface" }] }),
  ] } };
  assert.ok(CHANGE_TAG_EXEMPT.includes("ec2:DeleteNetworkInterface"));
  assert.deepEqual(abacLists(sar).change, ["ec2:DeleteNetworkAcl"]);
  assert.throws(() => renderLabPolicies({ services: ABAC_SERVICES, create: [], createOn: {}, change: ["ec2:DeleteNetwork*"], untag: [] }), /A82/);
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
  // Ruling A82: ec2:ReplaceNetwork* became ec2:ReplaceNetworkAclEntry (the association is exempt; CHANGE_TAG_EXEMPT).
  assert.ok(ABAC.change.includes("ec2:ReplaceNetworkAclEntry") && !ABAC.change.some((a) => /^ec2:ReplaceNetwork(\*|AclAssociation)$/.test(a)));
  // Batch 3 (2026-10-16): P2's API Gateway verbs moved to the change list, ec2:CopyImage (P4) and
  // elasticloadbalancing:DeleteLoadBalancer (P8) left the lists; nothing else changed in the reference.
  // Batch 4 (2026-10-16): the two peering accepts left the change list (P3), so ec2:AcceptTransit* and ec2:AcceptVpc*
  // split into the other accepts; ec2:CreateTrafficMirrorFilterRule left the create list (P17); and (fix round 1) the
  // rule's delete and modify left the change list, so ec2:DeleteTraffic* and ec2:ModifyTraffic* split; nothing else changed.
  // ans-21 fix (2026-10-17): the transit gateway route's create, replace and delete left the change list, so
  // ec2:DeleteTransitGatewayRoute* narrowed to ec2:DeleteTransitGatewayRouteTable*; nothing else changed.
  assert.equal(createHash("sha256").update(JSON.stringify({ create: ABAC.create, change: ABAC.change })).digest("hex"), "2c32f33b088169f88aab90efbc8c0a0fc3f1b6ee16d237f1c2755157d74b1397");
});

test("lab-policies.json is what --render makes from lab-abac.json", { skip }, () => {
  const { ABAC, POLICIES } = files();
  assert.deepEqual(POLICIES, renderLabPolicies(ABAC));
});

test("every role policy and the boundary fit (A29), and the role holds at most ROLE_POLICIES_MAX", { skip }, () => {
  const { POLICIES } = files();
  // Ruling P1: up to 20 (IAM's L-0DA4ABF3 is 20 in this account).
  assert.ok(POLICIES.role.length <= ROLE_POLICIES_MAX, `${POLICIES.role.length} role policies`);
  for (const [i, d] of POLICIES.role.entries()) assert.ok(policySize(d, FILL) < POLICY_MAX, `role policy ${i + 1}: ${policySize(d, FILL)}`);
  assert.ok(policySize(POLICIES.boundary, FILL) < POLICY_MAX);
});

test("each §7.1 statement says what it must", { skip }, () => {
  const { POLICIES, statements, sid } = files();
  for (const s of ["LabServices", "LabBuckets", "BucketList", "GlobalServices", "Identity", "LabRolesBounded", "LabRolesOther", "Lab07UsersBounded", "Lab07UsersOther", "PassLabRoles", "ServiceLinkedRoles", "DenyVpnServer", "DenyVpnTagRequest", "DenyVpnTagKeys", "DenyDefaultVpc", "DenyDefaultVpcChildren", "DenyAccountAndBilling", "DenyStackSets", "DenyIamOutsideLab", "DenyBoundaryRemoval", "DenyOtherRoles", "DenyOtherRegions", "DenyGlobalRegionsForLabServices", "CreateNeedsLabTagRunInstances", "KeepLabTag", "NaclOnlyInLabVpcs", "NaclMoveLabSubnetsOnly", "ElbDeleteLabOrEks"]) assert.ok(sid(s), s);
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

const FABRIC = ["CreateRoute", "ReplaceRoute", "DeleteRoute", "CreateNetworkAclEntry", "ReplaceNetworkAclEntry", "DeleteNetworkAclEntry", "DeleteNetworkAcl", "AssociateRouteTable", "DisassociateRouteTable", "ReplaceRouteTableAssociation", "DeleteRouteTable", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress", "RevokeSecurityGroupEgress", "ModifySecurityGroupRules", "UpdateSecurityGroupRuleDescriptionsIngress", "UpdateSecurityGroupRuleDescriptionsEgress", "DeleteSecurityGroup", "ModifyVpcAttribute", "DeleteVpc", "AttachInternetGateway", "DetachInternetGateway", "CreateSubnet", "AssociateVpcCidrBlock", "CreateVpcPeeringConnection", "AcceptVpcPeeringConnection"].map((a) => `ec2:${a}`);

test("ruling A48: the role and the boundary both tag only at create, never strip every tag, and change VPC fabric only with the lab tag", { skip }, () => {
  const { POLICIES, sid } = files();
  const bsid = (s) => POLICIES.boundary.Statement.find((x) => x.Sid === s);
  for (const get of [sid, bsid]) {
    // Fix round 2: only VPC fabric and network/compute items, so AWS Backup may still tag the snapshots it makes.
    assert.deepEqual(get("TagOnlyAtCreate"), { Sid: "TagOnlyAtCreate", Effect: "Deny", Action: "ec2:CreateTags", Resource: ["network-acl", "route-table", "security-group", "vpc", "subnet", "internet-gateway", "network-interface", "instance"].map((t) => `arn:aws:ec2:*:*:${t}/*`), Condition: { Null: { "ec2:CreateAction": "true", "aws:ResourceTag/cloudlabs-lab": "true" } } });
    assert.deepEqual(get("NoDeleteAllTags"), { Sid: "NoDeleteAllTags", Effect: "Deny", Action: "ec2:DeleteTags", Resource: "*", Condition: { Null: { "aws:TagKeys": "true" } } });
    const f = get("VpcFabricNeedsLabTag");
    assert.deepEqual(f.Action, FABRIC);
    assert.deepEqual(f.Resource, ["network-acl", "route-table", "security-group", "vpc"].map((t) => `arn:aws:ec2:*:*:${t}/*`));
    assert.deepEqual(f.Condition, { Null: { "aws:ResourceTag/cloudlabs-lab": "true" } });
  }
  // The boundary refuses the default VPCs as the role does (describes still answer).
  assert.deepEqual(bsid("NoDefaultVpc"), { Sid: "NoDefaultVpc", Effect: "Deny", NotAction: "ec2:Describe*", Resource: "__DEFAULT_VPC_ARNS__" });
  assert.deepEqual(bsid("NoDefaultVpcChildren"), { Sid: "NoDefaultVpcChildren", Effect: "Deny", NotAction: "ec2:Describe*", Resource: "*", Condition: { ArnEquals: { "ec2:Vpc": "__DEFAULT_VPC_ARNS__" } } });
  // Dashboards and Config recorders: the lab's own names only.
  assert.deepEqual(sid("LabDashboardsOnly").NotResource, "arn:aws:cloudwatch::__ACCOUNT__:dashboard/lab-*");
  assert.deepEqual(sid("LabRecordersOnly").NotResource, "arn:aws:config:*:__ACCOUNT__:configuration-recorder/lab-*");
  assert.ok(sid("LabRecordersOnly").Action.includes("config:StopConfigurationRecorder"));
});

test("fix round 2: account-wide EC2 settings are refused to the role and the boundary, from the reference's own list", { skip }, () => {
  const { ABAC, sid, POLICIES } = files();
  const bsid = (s) => POLICIES.boundary.Statement.find((x) => x.Sid === s);
  const pinned = ["ec2:ModifyVpcBlockPublicAccessOptions", "ec2:CreateVpcBlockPublicAccessExclusion", "ec2:ModifyVpcBlockPublicAccessExclusion", "ec2:DeleteVpcBlockPublicAccessExclusion", "ec2:EnableEbsEncryptionByDefault", "ec2:DisableEbsEncryptionByDefault", "ec2:ModifyEbsDefaultKmsKeyId", "ec2:ResetEbsDefaultKmsKeyId"];
  for (const a of pinned) assert.ok(ABAC.accountSettings.includes(a), a);
  assert.ok(ABAC.accountSettings.length >= 25, `${ABAC.accountSettings.length} settings`);
  assert.ok(!ABAC.accountSettings.includes("ec2:EnableImageDeprecation"), "names one image: not an account setting");
  for (const a of ABAC.accountSettings) {
    assert.ok(sid("DenyAccountAndBilling").Action.includes(a), `role: ${a}`);
    assert.ok(bsid("NoAccountOrBilling").Action.includes(a), `boundary: ${a}`);
  }
});

test("account settings come from the reference: setting writes with no resource type, and the named VPC Block Public Access ones", () => {
  const sar = { ec2: { Name: "ec2", Resources: [{ Name: "image", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }], Actions: [
    W({ Name: "EnableEbsEncryptionByDefault", Resources: [] }),
    W({ Name: "ModifyDefaultCreditSpecification", Resources: [] }),
    W({ Name: "EnableImageDeprecation", Resources: [{ Name: "image" }] }),
    W({ Name: "ModifyVpcBlockPublicAccessExclusion", Resources: [{ Name: "vpc-block-public-access-exclusion" }] }),
    { Name: "DescribeEbsDefaultKmsKeyId", Resources: [], Annotations: { Properties: { IsList: false } } },
  ] } };
  assert.deepEqual(abacLists(sar).accountSettings, ["ec2:EnableEbsEncryptionByDefault", "ec2:ModifyDefaultCreditSpecification", "ec2:ModifyVpcBlockPublicAccessExclusion"]);
});

test("final review, Important 3: SSM's account-level settings (the servicesetting type, the default patch baseline) are account settings", () => {
  const sar = { ssm: { Name: "ssm", Resources: [{ Name: "servicesetting" }, { Name: "patchbaseline", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }, { Name: "document" }], Actions: [
    W({ Name: "UpdateServiceSetting", Resources: [{ Name: "servicesetting" }] }),
    W({ Name: "ResetServiceSetting", Resources: [{ Name: "servicesetting" }] }),
    W({ Name: "RegisterDefaultPatchBaseline", Resources: [{ Name: "patchbaseline" }] }),
    W({ Name: "UpdatePatchBaseline", Resources: [{ Name: "patchbaseline" }] }),
    W({ Name: "CancelCommand", Resources: [] }),
    { Name: "GetServiceSetting", Resources: [{ Name: "servicesetting" }], Annotations: { Properties: { IsList: false } } },
  ] } };
  assert.deepEqual(abacLists(sar).accountSettings, ["ssm:RegisterDefaultPatchBaseline", "ssm:ResetServiceSetting", "ssm:UpdateServiceSetting"]);
});

test("final review, Important 3: the role and the boundary refuse SSM's account settings (Default Host Management would make the VPN server SSM-managed)", { skip }, () => {
  const { ABAC, sid, POLICIES } = files();
  const bsid = (s) => POLICIES.boundary.Statement.find((x) => x.Sid === s);
  for (const a of ["ssm:UpdateServiceSetting", "ssm:ResetServiceSetting", "ssm:RegisterDefaultPatchBaseline"]) {
    assert.ok(ABAC.accountSettings.includes(a), a);
    assert.ok(sid("DenyAccountAndBilling").Action.includes(a), `role: ${a}`);
    assert.ok(bsid("NoAccountOrBilling").Action.includes(a), `boundary: ${a}`);
  }
  const dhmc = `arn:aws:ssm:eu-west-2:${FILL.account}:servicesetting/ssm/managed-instance/default-ec2-instance-management-role`;
  for (const a of ["ssm:UpdateServiceSetting", "ssm:ResetServiceSetting"]) {
    assert.equal(decide(POLICIES.role, { action: a, resource: dhmc, ctx: { "aws:RequestedRegion": "eu-west-2" } }), "explicitDeny", `role: ${a}`);
    assert.equal(decide([POLICIES.boundary], { action: a, resource: dhmc, ctx: { "aws:RequestedRegion": "eu-west-2" } }), "explicitDeny", `boundary: ${a}`);
  }
  // Reading the setting stays allowed (the lab's own SSM pages show it).
  assert.equal(decide(POLICIES.role, { action: "ssm:GetServiceSetting", resource: dhmc, ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed");
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
  // The boundary names the default VPCs too, so both placeholders are filled there; the bootstrap's simulator needs them.
  assert.ok(tf.includes(`boundary_doc  = replace(replace(jsonencode(local.lab_policies.boundary), "__ACCOUNT__", local.account), "\\"__DEFAULT_VPC_ARNS__\\"", local.vpc_arns_json)`));
  assert.match(read("infra/aws-bootstrap/outputs.tf"), /output "default_vpc_arns" \{\n\s+value = local\.default_vpc_arns/);
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
  // Never anyone's user data (the VPN server's holds its WireGuard key and agent token): fix round 1, item 3.
  const never = block("NeverUserData");
  assert.match(never, /Effect\s+= "Deny"/);
  assert.match(never, /Action\s+= \["ec2:DescribeInstanceAttribute", "ec2:DescribeLaunchTemplateVersions"\]/);
  assert.match(never, /Resource\s+= "\*"/);
  assert.doesNotMatch(never, /Condition/);
});

test("the simulator cases are A19's, fix round 1's, batch 2's, batch 3's and batch 4's, and a wrong answer is a problem", () => {
  const cases = simulatorCases("123456789012", FILL.vpcArns);
  assert.deepEqual(cases.map((c) => [c.name, c.want]), [["tagged VPC", "allowed"], ["bounded lab role", "allowed"], ["untagged VPC", "denied"], ["the VPN server", "denied"], ["role without the boundary", "denied"], ["role outside the path", "denied"], ["access key", "denied"], ["a third region", "denied"],
    ["an entry in a lab network ACL", "allowed"], ["tag an untagged network ACL", "denied"], ["an entry in an untagged network ACL", "denied"], ["a rule in an untagged security group", "denied"], ["replace an ACL association off a default ACL", "allowed"], ["a network ACL in an untagged VPC", "denied"], ["move a lab subnet's ACL association", "allowed"], ["move an untagged subnet's ACL association", "denied"], ["move the VPN server's subnet's ACL association", "denied"], ["delete an untagged network interface (an EFS mount target's)", "allowed"], ["delete the VPN server's network interface", "denied"], ["the VPN server's user data", "denied"], ["pass the deploy role", "denied"], ["AdministratorAccess on a lab role", "denied"], ["change the boundary", "denied"], ["remove a boundary", "denied"], ["block public access for the account", "denied"], ["EBS encryption by default", "denied"], ["a launch whose volume has no lab tag", "denied"], ["EICE's network interface", "allowed"], ["an SSM association", "allowed"], ["retention on a new lab log group", "allowed"], ["retention on another log group", "denied"], ["SSM default host management", "denied"], ["reset an SSM setting", "denied"], ["a lab 07 user under the boundary", "allowed"], ["a user for another lab", "denied"], ["remove a hand-made key from the lab 07 user", "allowed"], ["delete the lab's analyzer", "allowed"], ["an untagged CloudFormation stack", "denied"], ["a CloudFront distribution", "allowed"], ["a Route 53 hosted zone", "allowed"], ["an ECS cluster in us-east-1", "denied"], ["a global table's replica in Ireland", "allowed"], ["an untagged table not named for a lab", "denied"], ["copy an AMI to Ireland", "allowed"], ["a tagged HTTP API", "allowed"], ["an untagged HTTP API", "denied"], ["a route on a lab API", "allowed"], ["delete an untagged API", "denied"], ["API Gateway's account settings", "denied"], ["delete a load balancer Kubernetes made for lab 19", "allowed"], ["delete an untagged load balancer", "denied"], ["the Spot service-linked role", "allowed"], ["a tagged transit gateway", "allowed"], ["an untagged transit gateway", "denied"], ["accept a peering attachment in Ireland, untagged there", "allowed"], ["accept a VPC peering into a lab VPC", "allowed"], ["accept an untagged VPC peering into a lab VPC", "allowed"], ["accept a VPC peering into an untagged VPC", "denied"], ["accept a VPC peering into the VPN server's VPC", "denied"], ["a tagged Client VPN endpoint", "allowed"], ["a tagged Network Firewall", "allowed"], ["a Global Accelerator in us-west-2", "allowed"], ["a WAF web ACL for CloudFront in us-east-1", "allowed"], ["CloudWatch Logs' account resource policy", "denied"], ["the IPAM service-linked role", "allowed"], ["vended log delivery to a lab bucket", "allowed"], ["a lab log bucket's policy", "allowed"], ["a mirror filter rule, untagged", "allowed"], ["a transit gateway route in a lab route table", "allowed"], ["a blackhole route's attachment ARN, untagged", "allowed"], ["a transit gateway route in an untagged route table", "denied"], ["a web ACL's managed rule set, untagged", "allowed"], ["an untagged WAF web ACL", "denied"], ["a subnet in the default VPC", "denied"], ["an ACL move in the default VPC", "denied"]]);
  // With no default VPC in the account there is nothing to ask about it.
  assert.ok(!simulatorCases("123456789012", []).some((c) => /default VPC/.test(c.name)));
  assert.deepEqual(boundaryCases("123456789012", FILL.vpcArns).map((c) => [c.name, c.want]), [["boundary: an entry in a lab network ACL", "allowed"], ["boundary: tag an untagged network ACL", "denied"], ["boundary: an entry in an untagged network ACL", "denied"], ["boundary: a rule in an untagged security group", "denied"], ["boundary: replace an ACL association off a default ACL", "allowed"], ["boundary: a network ACL in an untagged VPC", "denied"], ["boundary: move a lab subnet's ACL association", "allowed"], ["boundary: move an untagged subnet's ACL association", "denied"], ["boundary: move the VPN server's subnet's ACL association", "denied"], ["boundary: delete an untagged network interface (an EFS mount target's)", "allowed"], ["boundary: delete the VPN server's network interface", "denied"], ["boundary: delete every tag", "denied"], ["boundary: block public access for the account", "denied"], ["boundary: SSM default host management", "denied"], ["boundary: reset an SSM setting", "denied"], ["boundary: tag a new snapshot", "allowed"], ["boundary: a subnet in the default VPC", "denied"], ["boundary: an ACL move in the default VPC", "denied"]]);
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
  const c = [...simulatorCases("123456789012", FILL.vpcArns), ...boundaryCases("123456789012", FILL.vpcArns)].find((x) => x.action === opt("--action-names") && x.resource === opt("--resource-arns") && JSON.stringify(x.context.map((e) => ({ ContextKeyName: e.key, ContextKeyValues: e.values, ContextKeyType: e.type }))) === (x.context.length ? opt("--context-entries") : JSON.stringify([])));
  return c?.want === "allowed" ? "allowed" : "explicitDeny";
};
/** A fake command runner: answers by the aws command, records every call. */
function fakeAws({ decide = asWanted, quotas = {}, pending = [], costTag = "Inactive", eiceCode = "L-ABCD1234", failQuotaReads = false, slrThere = [], slrRefused = [] } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    const opt = (k) => args[args.indexOf(k) + 1];
    const ok = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
    if (a.startsWith("iam simulate-principal-policy") || a.startsWith("iam simulate-custom-policy")) return ok({ EvaluationResults: [{ EvalActionName: opt("--action-names"), EvalDecision: decide(opt) }] });
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
    if (a.startsWith("iam create-service-linked-role")) {
      const name = opt("--aws-service-name");
      if (slrThere.includes(name)) return { status: 254, stdout: "", stderr: "An error occurred (InvalidInput) when calling the CreateServiceLinkedRole operation: Service role name AWSServiceRoleForX has been taken in this account, please try a different suffix." };
      if (slrRefused.includes(name)) return { status: 254, stdout: "", stderr: "An error occurred (AccessDenied) when calling the CreateServiceLinkedRole operation: no" };
      return ok({ Role: { RoleName: "AWSServiceRoleForX" } });
    }
    return { status: 1, stdout: "", stderr: `unexpected ${a}` };
  };
  return { run, calls };
}
const BOUNDARY_DOC = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Workload", Effect: "Allow", Action: "ec2:*", Resource: "*" }] });
const O = { account: "123456789012", roleArn: "arn:aws:iam::123456789012:role/wg-admin-labs", defaultVpcArns: FILL.vpcArns, boundaryDoc: BOUNDARY_DOC };

test("--labs: every simulator case is asked of the role, quotas below target are raised, an inactive cost tag is activated", async () => {
  const log = [];
  const { run, calls } = fakeAws({ quotas: { "L-F678F1CE eu-west-2": 5, "L-F678F1CE eu-west-1": 20, "L-0263D0A3 eu-west-2": 5, "L-0263D0A3 eu-west-1": 5, "L-1216C47A eu-west-2": 32, "L-1216C47A eu-west-1": 16, "L-ABCD1234 eu-west-2": 5, "L-ABCD1234 eu-west-1": 10, "L-0DA4ABF3 us-east-1": 10 }, pending: ["L-0263D0A3 eu-west-1"] });
  const r = await runLabsBootstrap(run, { ...O, log: (s) => log.push(s) });
  assert.equal(r.ok, true);
  const sims = calls.filter((c) => c[2] === "simulate-principal-policy");
  assert.equal(sims.length, 75);
  for (const c of sims) assert.equal(c[c.indexOf("--policy-source-arn") + 1], O.roleArn);
  // The boundary, simulated as a policy of its own (simulate-custom-policy), with the document the bootstrap filled.
  const custom = calls.filter((c) => c[2] === "simulate-custom-policy");
  assert.equal(custom.length, 18);
  for (const c of custom) assert.equal(c[c.indexOf("--policy-input-list") + 1], BOUNDARY_DOC);
  const tagged = sims[0];
  assert.deepEqual(JSON.parse(tagged[tagged.indexOf("--context-entries") + 1]), [
    { ContextKeyName: "aws:RequestedRegion", ContextKeyValues: ["eu-west-2"], ContextKeyType: "string" },
    { ContextKeyName: "aws:RequestTag/cloudlabs-lab", ContextKeyValues: ["soa-01-x"], ContextKeyType: "string" },
    { ContextKeyName: "aws:TagKeys", ContextKeyValues: ["cloudlabs-lab"], ContextKeyType: "stringList" },
  ]);
  const raised = calls.filter((c) => c[2] === "request-service-quota-increase").map((c) => [c[c.indexOf("--quota-code") + 1], c[c.indexOf("--region") + 1], c[c.indexOf("--desired-value") + 1]]);
  assert.deepEqual(raised, [["L-F678F1CE", "eu-west-2", "20"], ["L-0263D0A3", "eu-west-2", "10"], ["L-1216C47A", "eu-west-1", "32"], ["L-ABCD1234", "eu-west-2", "10"], ["L-0DA4ABF3", "us-east-1", "20"]]);
  assert.ok(calls.some((c) => c.join(" ") === "aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=cloudlabs-lab,Status=Active --region us-east-1"));
  assert.ok(log.includes("Cost tag cloudlabs-lab: activated"));
  assert.ok(log.some((s) => /Instance Connect Endpoints per Region.*L-ABCD1234/.test(s)));
  // Names only: no ARN, no account id.
  assert.ok(!log.some((s) => s.includes("123456789012")), log.join("\n"));
});

test("--labs: ruling A57, the service-linked roles labs use are made ahead; ones there are left, ones AWS refuses are only reported", async () => {
  const log = [];
  const { run, calls } = fakeAws({ slrThere: ["elasticloadbalancing.amazonaws.com", "autoscaling.amazonaws.com"], slrRefused: ["transitgateway.amazonaws.com"] });
  const r = await runLabsBootstrap(run, { ...O, log: (s) => log.push(s) });
  assert.equal(r.ok, true, "a role AWS will not make ahead never fails the bootstrap");
  const asked = calls.filter((c) => c[2] === "create-service-linked-role").map((c) => c[c.indexOf("--aws-service-name") + 1]);
  assert.deepEqual(asked, [...SERVICE_LINKED]);
  const made = log.find((s) => s.startsWith("Service-linked roles made ahead: "));
  assert.ok(made && made.includes("rds.amazonaws.com") && !made.includes("autoscaling.amazonaws.com") && !made.includes("transitgateway"), made);
  assert.ok(log.some((s) => /would not make ahead.*transitgateway\.amazonaws\.com \(AccessDenied\)/.test(s)), log.join("\n"));
  const all = fakeAws({ slrThere: [...SERVICE_LINKED] });
  const log2 = [];
  await runLabsBootstrap(all.run, { ...O, log: (s) => log2.push(s) });
  assert.ok(log2.includes("Service-linked roles: all there"));
});

test("--labs: a simulator answer that differs fails loudly; an active or unseen cost tag is only reported", async () => {
  const log = [];
  const { run, calls } = fakeAws({ decide: () => "allowed", costTag: "Active", quotas: {} });
  // Every case answers "allowed": the six refusals are problems.
  const r = await runLabsBootstrap(run, { ...O, log: (s) => log.push(s) });
  assert.equal(r.ok, false);
  assert.ok(log.some((s) => /untagged VPC: wanted denied, AWS said allowed/.test(s)));
  assert.ok(log.some((s) => /boundary: tag an untagged network ACL: wanted denied, AWS said allowed/.test(s)));
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
  return JSON.parse(fillPolicy(doc, FILL));
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
  for (const c of simulatorCases(FILL.account, FILL.vpcArns)) {
    const d = decide(POLICIES.role, { action: c.action, resource: c.resource, ctx: ctxOf(c) });
    assert.equal(d === "allowed" ? "allowed" : "denied", c.want, `${c.name}: ${d}`);
  }
  // The boundary as its own policy, as simulate-custom-policy asks it.
  for (const c of boundaryCases(FILL.account, FILL.vpcArns)) {
    const d = decide([POLICIES.boundary], { action: c.action, resource: c.resource, ctx: ctxOf(c) });
    assert.equal(d === "allowed" ? "allowed" : "denied", c.want, `${c.name}: ${d}`);
  }
});

const A = FILL.account;
/** The ARN of a named item: a dashboard (global) or a Config recorder (name/id); anything else a stand-in. */
const namedArn = (action, name) => /^cloudwatch:.*Dashboard/.test(action) ? `arn:aws:cloudwatch::${A}:dashboard/${name}` : /^config:.*ConfigurationRecorder/.test(action) ? `arn:aws:config:eu-west-2:${A}:configuration-recorder/${name}/0abc` : `arn:aws:${action.split(":")[0]}:eu-west-2:${A}:${name}`;
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
  denied("ec2:RunInstances", `arn:aws:ec2:eu-west-2:${A}:volume/*`, { "aws:RequestedRegion": "eu-west-2" });
  // Ruling A54: an Instance Connect Endpoint's interface is made with no request tag.
  allowed("ec2:CreateNetworkInterface", `arn:aws:ec2:eu-west-2:${A}:network-interface/*`, { "aws:RequestedRegion": "eu-west-2" });
  // Ruling A55: SSM asks about AWS's document without the request's tags (soa-02's release test).
  for (const a of ["ssm:CreateAssociation", "ssm:CreateAssociationBatch"]) allowed(a, "arn:aws:ssm:eu-west-2::document/AWS-RunPatchBaseline", { "aws:RequestedRegion": "eu-west-2" });
  allowed("ssm:DeleteAssociation", `arn:aws:ssm:eu-west-2:${A}:association/0abc`, LAB);
  denied("ssm:DeleteAssociation", `arn:aws:ssm:eu-west-2:${A}:association/0abc`, { "aws:RequestedRegion": "eu-west-2" });
  // Ruling A56: a lab log group, by its name, before its tag can be read (soa-01's release test); any other needs the tag.
  const lg = (n) => `arn:aws:logs:eu-west-2:${A}:log-group:${n}`;
  for (const a of ["logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:PutMetricFilter", "logs:CreateLogStream"]) {
    allowed(a, lg("/cloudlabs/soa-01-x/app"), { "aws:RequestedRegion": "eu-west-2" });
    allowed(a, `${lg("/cloudlabs/soa-01-x/app")}:log-stream:i-0abc`, { "aws:RequestedRegion": "eu-west-2" });
    denied(a, lg("/aws/other"), { "aws:RequestedRegion": "eu-west-2" });
    allowed(a, lg("/aws/other"), LAB);
  }
  denied("logs:CreateLogGroup", lg("/cloudlabs/soa-01-x/app"), { "aws:RequestedRegion": "eu-west-2" });
  denied("logs:PutRetentionPolicy", lg("/cloudlabs/vpn"), { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/wg-admin": "vpn" });
  // The untaggable types a lab names lab-<id>-* (lab-scope-aws.mjs UNTAGGABLE): made and removed without a tag.
  for (const a of ["cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards", "config:PutConfigurationRecorder", "config:StartConfigurationRecorder", "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:PutDeliveryChannel", "config:DeleteDeliveryChannel", "logs:PutQueryDefinition", "logs:DeleteQueryDefinition", "kms:CreateAlias", "kms:DeleteAlias", "ssm:RegisterPatchBaselineForPatchGroup"]) {
    allowed(a, namedArn(a, "lab-soa-01-x-thing"), { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/cloudlabs-lab": a.startsWith("ssm:") ? "soa-01-x" : undefined });
  }
  // ... but only the lab's own names: never the account's default recorder or another dashboard (fix round 1, item 6).
  for (const a of ["cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards", "config:PutConfigurationRecorder", "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder"]) denied(a, namedArn(a, "default"), { "aws:RequestedRegion": "eu-west-2" });
  // Tagging only at create, or on what already carries the lab tag (fix round 1, ruling A48).
  const acl = `arn:aws:ec2:eu-west-2:${A}:network-acl/acl-0123456789abcdef0`;
  denied("ec2:CreateTags", acl, { ...NEW });
  allowed("ec2:CreateTags", acl, { ...NEW, "ec2:CreateAction": "CreateNetworkAcl" });
  allowed("ec2:CreateTags", acl, { ...LAB, "aws:RequestTag/Name": "acl-x", "aws:TagKeys": ["Name"] });
  denied("ec2:DeleteTags", acl, LAB);
  // A snapshot AWS Backup (or the lab) has just made: tagging it is not refused (fix round 2).
  allowed("ec2:CreateTags", `arn:aws:ec2:eu-west-2::snapshot/snap-0123456789abcdef0`, NEW);
  // Account-wide EC2 settings: never (fix round 2).
  for (const a of ["ec2:ModifyVpcBlockPublicAccessOptions", "ec2:EnableEbsEncryptionByDefault", "ec2:ModifyEbsDefaultKmsKeyId", "ec2:ModifyInstanceMetadataDefaults", "ec2:EnableSerialConsoleAccess"]) denied(a, "*", { "aws:RequestedRegion": "eu-west-2" });
  allowed("ec2:DeleteTags", acl, { ...LAB, "aws:TagKeys": ["Name"] });
  // VPC fabric needs the lab tag: never the VPN VPC's (or any) untagged default ACL, security group or main route table.
  // (Not ReplaceNetworkAclAssociation: ruling A82, below.)
  const fabric = { "network-acl/acl-0123456789abcdef0": ["ec2:CreateNetworkAclEntry", "ec2:ReplaceNetworkAclEntry", "ec2:DeleteNetworkAclEntry"], "security-group/sg-0123456789abcdef0": ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:ModifySecurityGroupRules"], "route-table/rtb-0123456789abcdef0": ["ec2:CreateRoute", "ec2:ReplaceRoute", "ec2:DeleteRoute", "ec2:ReplaceRouteTableAssociation"], "vpc/vpc-0aaaaaaaaaaaaaaa1": ["ec2:CreateSubnet", "ec2:AttachInternetGateway", "ec2:CreateVpcPeeringConnection", "ec2:AssociateVpcCidrBlock"] };
  for (const [r, actions] of Object.entries(fabric)) for (const a of actions) {
    denied(a, `arn:aws:ec2:eu-west-2:${A}:${r}`, { ...NEW });
    allowed(a, `arn:aws:ec2:eu-west-2:${A}:${r}`, { ...LAB, "aws:RequestTag/cloudlabs-lab": "soa-01-x", "aws:TagKeys": ["cloudlabs-lab"] });
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
const CLI_SERVICE = { elbv2: "elasticloadbalancing", elb: "elasticloadbalancing", configservice: "config", resourcegroupstaggingapi: "tag", s3api: "s3", accessanalyzer: "access-analyzer", apigatewayv2: "apigateway", stepfunctions: "states", efs: "elasticfilesystem" };
const CLI_ACTION = {
  "s3api head-bucket": ["s3:ListBucket"],
  "s3api list-object-versions": ["s3:ListBucketVersions"],
  "s3api delete-objects": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
  "s3api get-object-lock-configuration": ["s3:GetBucketObjectLockConfiguration"],
  // Ruling P2: API Gateway's actions are its HTTP verbs.
  "apigatewayv2 get-api": ["apigateway:GET"],
  "apigatewayv2 get-stage": ["apigateway:GET"],
  "apigatewayv2 delete-api": ["apigateway:DELETE"],
};
const SERVICES_RE = /(?:^|[\s(])(ec2|elbv2|rds|autoscaling|events|configservice|s3api|sns|logs|cloudwatch|ssm|backup|resource-groups|kms|iam|resourcegroupstaggingapi|dynamodb|network-firewall|cloudformation|elasticache|eks|ecs|cloudfront|globalaccelerator|wafv2|vpc-lattice|route53resolver|sqs|secretsmanager|lambda|ecr|accessanalyzer|route53|elb|apigatewayv2|cognito-idp|stepfunctions|efs|kinesis|firehose|glue|athena|acm)\s+"?([a-z0-9]+-[a-z0-9$-]+)"?/g;
/** Every "<service> <command>" an aws call names in a script (comments left out), with the region it names. */
function cliCalls(path) {
  const out = [];
  for (const line of read(path).split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(SERVICES_RE)) {
      const cmds = m[2].includes("$dir") ? [m[2].replace("$dir", "ingress"), m[2].replace("$dir", "egress")] : [m[2]];
      const region = /--region (us-east-1|us-west-2)\b/.exec(line)?.[1];
      const scope = /--scope (CLOUDFRONT|REGIONAL)\b/.exec(line)?.[1];
      for (const c of cmds) out.push({ cli: `${m[1]} ${c}`, region, scope });
    }
  }
  return out;
}
const camel = (c) => c.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
/** The IAM request one CLI call makes, on a lab item (tagged, or one of the untaggable named types). */
function requestsOf({ cli, region, scope }) {
  const [svc, cmd] = cli.split(" ");
  const actions = CLI_ACTION[cli] ?? [`${CLI_SERVICE[svc] ?? svc}:${camel(cmd)}`];
  const read = /^(describe|list|get|head)-/.test(cmd);
  const named = /dashboard|configuration-recorder|delivery-channel|query-definition|alias|origin-access-control/.test(cmd);
  const action0 = actions[0];
  if (svc === "iam") {
    const what = /instance-profile/.test(cmd) ? "instance-profile" : /policy-version|^(get|delete)-policy$/.test(cmd) ? "policy" : /user|login-profile|access-key|mfa-device|ssh-public-key|signing-certificate|service-specific-credential/.test(cmd) ? "user" : /role/.test(cmd) ? "role" : null;
    const name = what === "user" ? "lab-soa-07-iam-kms-ann" : "lab-soa-01-x-vm";
    const resource = what && !/^list-(roles|instance-profiles|policies|users)$/.test(cmd) ? `arn:aws:iam::${A}:${what}/cloudlabs-lab/${name}` : "*";
    return actions.map((action) => ({ action, resource, ctx: { "aws:RequestedRegion": "us-east-1", ...(what === "role" || what === "user" ? BOUNDED : {}) } }));
  }
  // The global APIs in their regions (A65, P9): a CloudFront-scope WAF call in us-east-1, Global Accelerator in us-west-2.
  const r = region ?? (["cloudfront", "route53"].includes(svc) || (svc === "wafv2" && scope === "CLOUDFRONT") ? "us-east-1" : svc === "globalaccelerator" ? "us-west-2" : "eu-west-2");
  const resource = svc === "s3api" ? "arn:aws:s3:::cloudlabs-a01abcde-logs" : /dashboard|configuration-recorder/.test(cmd) ? namedArn(action0, "lab-soa-01-x-main") : svc === "dynamodb" ? `arn:aws:dynamodb:${r}:${A}:table/lab-soa-01-x-items` : `arn:aws:${CLI_SERVICE[svc] ?? svc}:${r}:${A}:lab-item/x`;
  // Ruling P4: an AMI copy and its snapshots are never tag-checked (deregistering and snapshot deletes are AWS_OWNED_TYPES).
  const untagged = svc === "ec2" && /image|snapshot/.test(cmd);
  // A read must not need the lab's tag; a write is on a tagged item, or a named one that cannot carry tags.
  const ctx = { "aws:RequestedRegion": r, ...(read || named || untagged ? {} : { "aws:ResourceTag/cloudlabs-lab": "soa-01-x" }) };
  return actions.map((action) => ({ action, resource, ctx }));
}

test("every AWS CLI call in Unblock, the safety net, Verify clean and the ready check is allowed to wg-admin-labs", { skip }, () => {
  const { POLICIES } = files();
  const scripts = ["infra/ci/lab-unblock-aws.sh", "infra/ci/lab-aws-safety-net.sh", "infra/ci/lab-ready-aws.sh"];
  const calls = scripts.flatMap((p) => cliCalls(p).map((c) => ({ ...c, p })));
  // The extraction found the calls (a script that stops naming them would make this test vacuous).
  assert.ok(calls.length > 185, `${calls.length} calls`);
  for (const must of ["iam delete-role", "configservice stop-configuration-recorder", "cloudwatch delete-dashboards", "ec2 revoke-security-group-egress", "resourcegroupstaggingapi get-resources", "cloudfront get-distribution", "s3api delete-objects",
    // Final review, Important 2: security group rules, listeners and listener rules, read and (when still there) deleted.
    "ec2 describe-security-group-rules", "ec2 revoke-security-group-ingress", "elbv2 describe-listeners", "elbv2 describe-rules", "elbv2 delete-listener", "elbv2 delete-rule",
    // Batch 2 (Task 4): the new types' deletes.
    "cloudformation delete-stack", "cloudfront delete-distribution", "cloudfront delete-origin-access-control", "route53 delete-hosted-zone", "ecs delete-service", "ecs delete-task-definitions", "kms schedule-key-deletion", "iam delete-access-key", "accessanalyzer delete-analyzer",
    // Batch 3 (Task 4): the new types' deletes, Unblock's Kubernetes-made load balancers and EKS deletion protection (pre-flight C9).
    "eks delete-nodegroup", "eks delete-cluster", "dynamodb update-table", "dynamodb delete-table", "apigatewayv2 delete-api", "cognito-idp delete-user-pool", "efs delete-mount-target", "elasticache delete-replication-group", "kinesis delete-stream", "firehose delete-delivery-stream", "glue stop-crawler", "glue delete-database", "athena delete-work-group", "stepfunctions delete-state-machine", "elbv2 delete-load-balancer", "elb delete-load-balancer", "eks update-cluster-config",
    // Batch 4 (Task 5): edge, DNS and Lattice.
    "globalaccelerator update-accelerator", "globalaccelerator delete-accelerator", "globalaccelerator delete-endpoint-group", "globalaccelerator delete-listener", "wafv2 delete-web-acl", "cloudfront delete-function", "route53resolver delete-resolver-rule", "route53resolver disassociate-resolver-rule", "route53resolver delete-resolver-endpoint", "route53resolver delete-firewall-rule", "vpc-lattice delete-service", "vpc-lattice deregister-targets", "vpc-lattice delete-service-network",
    // Batch 4 (Task 6): network services, IPAM and certificates.
    "ec2 delete-client-vpn-endpoint", "ec2 disassociate-client-vpn-target-network", "network-firewall delete-firewall", "ec2 delete-vpc-endpoint-service-configurations", "ec2 reject-vpc-endpoint-connections", "ec2 delete-traffic-mirror-target", "ec2 delete-vpn-connection", "ec2 detach-vpn-gateway", "ec2 delete-transit-gateway-peering-attachment", "ec2 delete-transit-gateway", "ec2 delete-ipam", "acm delete-certificate"]) assert.ok(calls.some((c) => c.cli === must), must);
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

test("A29's fall-back: lists too long for ROLE_POLICIES_MAX policies become per-service Delete/Modify/Update/Terminate wildcards", () => {
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

test("ruling P1: a delete or update that takes a request tag is a change, never a create (DeleteAnalyzer)", () => {
  const props = { Annotations: { Properties: { IsWrite: true } } };
  const sar = {
    "access-analyzer": {
      Name: "access-analyzer",
      Resources: [{ Name: "Analyzer", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }],
      Actions: [
        { Name: "CreateAnalyzer", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Analyzer" }], ...props },
        { Name: "DeleteAnalyzer", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Analyzer" }], ...props },
        { Name: "UpdateAnalyzer", ActionConditionKeys: [], Resources: [{ Name: "Analyzer" }], ...props },
      ],
    },
  };
  const { create, change } = abacLists(sar);
  assert.deepEqual(create, ["access-analyzer:CreateAnalyzer"]);
  assert.deepEqual(change, ["access-analyzer:DeleteAnalyzer", "access-analyzer:UpdateAnalyzer"]);
});

test("ruling P1: the committed create list holds no delete or update verb", { skip }, () => {
  const { ABAC } = files();
  assert.deepEqual(ABAC.create.filter((a) => NON_CREATE_VERB.test(a.split(":")[1])), []);
  // Fold-proof (pre-flight C16): the delete may sit under a wildcard such as access-analyzer:Delete*.
  assert.ok(ABAC.change.some((a) => new RegExp(`^${a.replace(/\*/g, ".*")}$`, "i").test("access-analyzer:DeleteAnalyzer")), "the analyzer's delete is a change, judged by the lab tag");
});

test("rulings P6 and P14: lab 07's user can lose hand-made credentials; Access Analyzer's role is made ahead", { skip }, () => {
  const { sid } = files();
  for (const a of ["iam:DeleteAccessKey", "iam:UpdateAccessKey", "iam:DeleteSSHPublicKey", "iam:DeleteSigningCertificate", "iam:DeleteServiceSpecificCredential", "iam:DeactivateMFADevice", "iam:UntagUser"]) assert.ok(sid("Lab07UsersOther").Action.includes(a), a);
  assert.ok(!sid("Lab07UsersOther").Action.includes("iam:CreateAccessKey"));
  assert.ok(SERVICE_LINKED.includes("access-analyzer.amazonaws.com"));
});

test("ruling P13: the managed-policies-per-role quota is asked for in us-east-1 only", () => {
  const q = LAB_QUOTAS.find((x) => x.code === "L-0DA4ABF3");
  assert.deepEqual([q.service, q.want, q.raise, q.regions], ["iam", 20, "if-below", ["us-east-1"]]);
});

test("what labs 06–10 do is allowed: tagged creates, deletes of tagged items, lab 07's user and its hand-made credentials", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const denied = (action, resource, ctx) => assert.notEqual(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const R = { "aws:RequestedRegion": "eu-west-2" };
  const arn = (svc, rest) => `arn:aws:${svc}:eu-west-2:${A}:${rest}`;
  // Lab 06: a tagged stack, run by its own role; its update and delete are changes on the tagged stack (P1).
  allowed("cloudformation:CreateStack", arn("cloudformation", "stack/lab-soa-06-x-stack/*"), NEW);
  denied("cloudformation:CreateStack", arn("cloudformation", "stack/lab-soa-06-x-stack/*"), R);
  for (const a of ["cloudformation:UpdateStack", "cloudformation:DeleteStack"]) allowed(a, arn("cloudformation", "stack/lab-soa-06-x-stack/0abc"), LAB);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-06-x-cfn`, { "iam:PassedToService": "cloudformation.amazonaws.com" });
  // Review I1 (P4): stack sets are never a lab's, even with the lab's request tag (an existing one's execution role is not a lab role).
  for (const a of ["cloudformation:UpdateStackSet", "cloudformation:CreateStackSet", "cloudformation:CreateStackInstances", "cloudformation:UpdateStackInstances", "cloudformation:ImportStacksToStackSet"]) assert.equal(decide(POLICIES.role, { action: a, resource: arn("cloudformation", "stackset/other:0abc"), ctx: { ...R, "aws:RequestTag/cloudlabs-lab": "soa-06-x" } }), "explicitDeny", a);
  // Lab 07: the user, its login profile and policy; hand-made credentials removed; never an access key made.
  const ann = `arn:aws:iam::${A}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`;
  allowed("iam:CreateUser", ann, BOUNDED);
  for (const a of ["iam:TagUser", "iam:CreateLoginProfile", "iam:DeleteLoginProfile", "iam:DeleteAccessKey", "iam:DeactivateMFADevice", "iam:DeleteSSHPublicKey", "iam:DeleteSigningCertificate", "iam:DeleteServiceSpecificCredential", "iam:UpdateAccessKey", "iam:UntagUser", "iam:DeleteUser"]) allowed(a, ann, {});
  allowed("iam:AttachUserPolicy", ann, { ...BOUNDED, "iam:PolicyARN": `arn:aws:iam::${A}:policy/cloudlabs-lab/lab-soa-07-iam-kms-ann` });
  denied("iam:CreateAccessKey", ann, {});
  denied("iam:DeleteAccessKey", `arn:aws:iam::${A}:user/someone`, {});
  for (const a of ["iam:DeactivateMFADevice", "iam:DeleteSSHPublicKey"]) denied(a, `arn:aws:iam::${A}:user/someone`, {});
  allowed("access-analyzer:CreateAnalyzer", arn("access-analyzer", "analyzer/lab-soa-07-iam-kms-account"), NEW);
  allowed("access-analyzer:DeleteAnalyzer", arn("access-analyzer", "analyzer/lab-soa-07-iam-kms-account"), LAB);
  denied("access-analyzer:DeleteAnalyzer", arn("access-analyzer", "analyzer/other"), R);
  allowed("kms:CreateKey", "*", NEW);
  allowed("kms:ScheduleKeyDeletion", arn("kms", "key/0abc"), LAB);
  allowed("secretsmanager:CreateSecret", arn("secretsmanager", "secret:lab-soa-07-iam-kms-app-a07k3x9q-AbCdEf"), NEW);
  for (const a of ["secretsmanager:PutSecretValue", "secretsmanager:RotateSecret", "secretsmanager:DeleteSecret", "secretsmanager:CancelRotateSecret"]) allowed(a, arn("secretsmanager", "secret:lab-soa-07-iam-kms-app-a07k3x9q-AbCdEf"), LAB);
  allowed("lambda:CreateFunction", arn("lambda", "function:lab-soa-07-iam-kms-rotate"), NEW);
  for (const a of ["lambda:AddPermission", "lambda:DeleteFunction", "lambda:RemovePermission"]) allowed(a, arn("lambda", "function:lab-soa-07-iam-kms-rotate"), LAB);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-07-iam-kms-rotate`, { "iam:PassedToService": "lambda.amazonaws.com" });
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/access-analyzer.amazonaws.com/AWSServiceRoleForAccessAnalyzer`, { "iam:AWSServiceName": "access-analyzer.amazonaws.com" });
  // Lab 08: a second VPC, its own network ACL (entries and association on the lab's ACL), peering, flow logs.
  allowed("ec2:CreateNetworkAcl", arn("ec2", "network-acl/*"), NEW);
  allowed("ec2:ReplaceNetworkAclAssociation", arn("ec2", "network-acl/acl-0lab"), LAB);
  allowed("ec2:CreateVpcPeeringConnection", arn("ec2", "vpc-peering-connection/*"), NEW);
  allowed("ec2:AcceptVpcPeeringConnection", arn("ec2", "vpc-peering-connection/pcx-0lab"), LAB);
  allowed("ec2:CreateFlowLogs", arn("ec2", "vpc-flow-log/*"), NEW);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-08-vpc-fix-flowlogs`, { "iam:PassedToService": "vpc-flow-logs.amazonaws.com" });
  // Lab 09: CloudFront and Route 53 in us-east-1 (global APIs), the site bucket by name and its policy.
  for (const a of ["cloudfront:CreateDistribution", "cloudfront:CreateOriginAccessControl", "cloudfront:DeleteDistribution", "route53:CreateHostedZone", "route53:ChangeResourceRecordSets", "route53:CreateHealthCheck", "route53:DeleteHostedZone"]) allowed(a, "*", { "aws:RequestedRegion": "us-east-1" });
  allowed("s3:PutBucketPolicy", "arn:aws:s3:::cloudlabs-a09k3x9q-site", R);
  // Lab 10: NAT gateway and its address, ECR, ECS (deregistering takes no resource), the task execution role.
  allowed("ec2:AllocateAddress", arn("ec2", "elastic-ip/*"), NEW);
  allowed("ec2:CreateNatGateway", arn("ec2", "natgateway/*"), NEW);
  allowed("ecr:CreateRepository", arn("ecr", "repository/lab-soa-10-containers-web"), NEW);
  for (const a of ["ecr:PutLifecyclePolicy", "ecr:DeleteRepository"]) allowed(a, arn("ecr", "repository/lab-soa-10-containers-web"), LAB);
  for (const [a, r] of [["ecs:CreateCluster", "cluster/lab-soa-10-containers"], ["ecs:RegisterTaskDefinition", "task-definition/lab-soa-10-containers-web:1"], ["ecs:CreateService", "service/lab-soa-10-containers/lab-soa-10-containers-web"]]) allowed(a, arn("ecs", r), NEW);
  for (const [a, r] of [["ecs:UpdateService", "service/lab-soa-10-containers/x"], ["ecs:DeleteService", "service/lab-soa-10-containers/x"], ["ecs:DeleteCluster", "cluster/lab-soa-10-containers"], ["ecs:DeleteTaskDefinitions", "task-definition/lab-soa-10-containers-web:1"]]) allowed(a, arn("ecs", r), LAB);
  allowed("ecs:DeregisterTaskDefinition", "*", R);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-10-containers-exec`, { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
});

test("ruling A82: a lab may move a subnet off its VPC's untagged default ACL onto its own, and makes ACLs only in lab VPCs (role and boundary)", { skip }, () => {
  const { POLICIES, sid } = files();
  const bsid = (s) => POLICIES.boundary.Statement.find((x) => x.Sid === s);
  for (const get of [sid, bsid]) {
    assert.deepEqual(get("NaclOnlyInLabVpcs"), { Sid: "NaclOnlyInLabVpcs", Effect: "Deny", Action: "ec2:CreateNetworkAcl", Resource: "arn:aws:ec2:*:*:vpc/*", Condition: { Null: { "aws:ResourceTag/cloudlabs-lab": "true" } } });
    assert.ok(!get("VpcFabricNeedsLabTag").Action.includes("ec2:ReplaceNetworkAclAssociation"));
  }
  const arn = (rest) => `arn:aws:ec2:eu-west-2:${A}:${rest}`;
  const R = { "aws:RequestedRegion": "eu-west-2" };
  const defaultAcl = arn("network-acl/acl-0default0000000000");
  for (const [who, docs] of [["role", POLICIES.role], ["boundary", [POLICIES.boundary]]]) {
    const allowed = (action, resource, ctx) => assert.equal(decide(docs, { action, resource, ctx }), "allowed", `${who}: ${action} on ${resource}`);
    const denied = (action, resource, ctx) => assert.notEqual(decide(docs, { action, resource, ctx }), "allowed", `${who}: ${action} on ${resource}`);
    // AWS asks about the ACL being replaced too: a new subnet always starts on its VPC's untagged default ACL.
    allowed("ec2:ReplaceNetworkAclAssociation", defaultAcl, R);
    allowed("ec2:ReplaceNetworkAclAssociation", arn("network-acl/acl-0lab"), LAB);
    // An ACL is made only inside a VPC that carries the lab tag.
    denied("ec2:CreateNetworkAcl", arn("vpc/vpc-0untagged"), NEW);
    allowed("ec2:CreateNetworkAcl", arn("vpc/vpc-0lab"), { ...NEW, "aws:ResourceTag/cloudlabs-lab": "soa-08-vpc-fix" });
    allowed("ec2:CreateNetworkAcl", arn("network-acl/*"), NEW);
    // The default ACL's rules stay untouchable; the VPN server's items and the default VPC's children stay refused.
    denied("ec2:CreateNetworkAclEntry", defaultAcl, R);
    denied("ec2:ReplaceNetworkAclAssociation", defaultAcl, { ...R, "aws:ResourceTag/wg-admin": "vpn" });
    denied("ec2:CreateNetworkAcl", arn("vpc/vpc-0vpn"), { ...NEW, "aws:ResourceTag/cloudlabs-lab": "soa-08-vpc-fix", "aws:ResourceTag/wg-admin": "vpn" });
    denied("ec2:ReplaceNetworkAclAssociation", defaultAcl, { ...R, "ec2:Vpc": FILL.vpcArns[0] });
    denied("ec2:CreateNetworkAcl", FILL.vpcArns[0], { ...NEW, "aws:ResourceTag/cloudlabs-lab": "soa-08-vpc-fix" });
    // Review Low-1/Low-2: AWS also asks about the subnet. Only a lab subnet's ACL may move; the VPN server's subnets
    // are refused twice (DenyVpnServer and NaclMoveLabSubnetsOnly), a default VPC's by the default-VPC deny.
    const subnet = arn("subnet/subnet-0123456789abcdef0");
    const labSubnet = { ...R, "aws:ResourceTag/cloudlabs-lab": "soa-08-vpc-fix" };
    allowed("ec2:ReplaceNetworkAclAssociation", subnet, labSubnet);
    allowed("ec2:ReplaceNetworkAclAssociation", defaultAcl, R);
    allowed("ec2:ReplaceNetworkAclAssociation", arn("network-acl/acl-0lab"), labSubnet);
    denied("ec2:ReplaceNetworkAclAssociation", subnet, R);
    denied("ec2:ReplaceNetworkAclAssociation", subnet, { ...R, "aws:ResourceTag/wg-admin": "vpn" });
    denied("ec2:ReplaceNetworkAclAssociation", subnet, { ...labSubnet, "ec2:Vpc": FILL.vpcArns[0] });
  }
  for (const get of [sid, bsid]) {
    assert.deepEqual(get("NaclMoveLabSubnetsOnly"), { Sid: "NaclMoveLabSubnetsOnly", Effect: "Deny", Action: "ec2:ReplaceNetworkAclAssociation", Resource: "arn:aws:ec2:*:*:subnet/*", Condition: { Null: { "aws:ResourceTag/cloudlabs-lab": "true" } } });
  }
  // The VPN server's subnet is refused even without the new deny (DenyVpnServer), and by it even without DenyVpnServer.
  const vpnSubnet = { action: "ec2:ReplaceNetworkAclAssociation", resource: arn("subnet/subnet-0vpn"), ctx: { ...R, "aws:ResourceTag/wg-admin": "vpn" } };
  for (const drop of ["DenyVpnServer", "NaclMoveLabSubnetsOnly"]) {
    const docs = POLICIES.role.map((d) => ({ ...d, Statement: d.Statement.filter((s) => s.Sid !== drop) }));
    assert.equal(decide(docs, vpnSubnet), "explicitDeny", `without ${drop}`);
  }
});

// ── Batch 3 (labs 11–19): rulings P1–P4, P8, P10 ──────────────────────────

test("ruling P2: API Gateway's verbs: POST is a create on /apis only; PUT, PATCH and DELETE need the lab tag; /account is refused", () => {
  const verb = (Name) => ({ Name, ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Api" }, { Name: "Apis" }, { Name: "Account" }], Annotations: { Properties: { IsWrite: Name !== "GET" } } });
  const sar = {
    apigateway: {
      Name: "apigateway",
      Resources: [
        { Name: "Api", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/apis/${ApiId}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
        { Name: "Apis", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/apis"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
        { Name: "Account", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/account"], ConditionKeys: [] },
      ],
      Actions: ["GET", "POST", "PUT", "PATCH", "DELETE"].map(verb),
    },
  };
  const { create, change, createOn, untag } = abacLists(sar);
  assert.deepEqual(create, ["apigateway:POST"]);
  assert.deepEqual(createOn["apigateway:POST"], HTTP_VERB_RULES.apigateway.postCreatesOn);
  assert.deepEqual(change, ["apigateway:DELETE", "apigateway:PATCH", "apigateway:PUT"]);
  assert.ok(untag.includes("apigateway:DELETE"));
  const { role } = renderLabPolicies({ services: ["apigateway"], create, change, createOn, untag });
  const d = (action, resource, ctx) => decide(role, { action, resource, ctx });
  const R = { "aws:RequestedRegion": "eu-west-2" };
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis", { ...R, "aws:RequestTag/cloudlabs-lab": "saa-12-x" }), "allowed");
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis", R), "explicitDeny");
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis/a1/routes", R), "allowed");
  // Pre-flight C17, option (b): the tag is asked for only on the API, its stages, /account and the other top-level
  // paths (an API id is 10 characters); a route, integration or authoriser is judged by nothing.
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5", { ...R, "aws:ResourceTag/cloudlabs-lab": "saa-12-x" }), "allowed");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5", R), "explicitDeny");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5/routes/x", R), "allowed");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5/integrations/y", R), "allowed");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5/stages/$default", R), "explicitDeny");
  assert.equal(d("apigateway:PATCH", "arn:aws:apigateway:eu-west-2::/restapis/r1b2c3d4e5", R), "explicitDeny");
  assert.equal(d("apigateway:PUT", "arn:aws:apigateway:eu-west-2::/domainnames/api.example.com", R), "explicitDeny");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/vpclinks/v1", R), "explicitDeny");
  assert.equal(d("apigateway:PATCH", "arn:aws:apigateway:eu-west-2::/account", R), "explicitDeny");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/tags/x", { ...R, "aws:ResourceTag/cloudlabs-lab": "saa-12-x", "aws:TagKeys": ["cloudlabs-lab"] }), "explicitDeny", "never untag the lab tag");
  const verbs = role.flatMap((x) => x.Statement).filter((s) => [].concat(s.Action).includes("apigateway:DELETE") && /^ChangeNeedsLabTag/.test(s.Sid));
  assert.equal(verbs.length, 1);
  assert.deepEqual(verbs[0].Resource, HTTP_VERB_RULES.apigateway.changesOn);
});

test("pre-flight C17 (b): no other action's wildcard covers an HTTP verb (it would refuse the verb on every path)", () => {
  const sar = { apigateway: { Name: "apigateway", Resources: [{ Name: "Portal", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }], Actions: [
    W({ Name: "PutPortalPolicy", Resources: [{ Name: "Portal" }] }),
    W({ Name: "PutPortalThing", Resources: [{ Name: "Portal" }] }),
    W({ Name: "PUT", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "Portal" }] }),
  ] } };
  // Without keeping the verbs out of the fold, the three would fold into apigateway:Put*.
  assert.deepEqual(abacLists(sar).change, ["apigateway:PUT", "apigateway:PutPortal*"]);
  const abac = { services: ["apigateway"], create: [], createOn: {}, untag: [] };
  assert.throws(() => renderLabPolicies({ ...abac, change: ["apigateway:Put*", "apigateway:PUT"] }), /apigateway:Put\*.*P2/);
  assert.throws(() => renderLabPolicies({ ...abac, change: ["apigateway:De*"] }), /P2/);
  assert.doesNotThrow(() => renderLabPolicies({ ...abac, change: ["apigateway:PUT", "apigateway:PutPortal*", "apigateway:DeletePortal*"] }));
});

test("rulings P3 and P4: DynamoDB is refused only outside table/lab-*; CopyImage is exempt; both lists say so", { skip }, () => {
  const { ABAC, POLICIES } = files();
  assert.ok(!ABAC.create.some((a) => /^ec2:Copy(Image|\*)/.test(a)), "CopyImage is in no create list (ruling P4)");
  assert.ok(ABAC.create.includes("dynamodb:CreateTable"));
  const st = POLICIES.role.flatMap((d) => d.Statement);
  const dyn = st.filter((s) => s.Effect === "Deny" && [].concat(s.Action ?? []).some((a) => a.startsWith("dynamodb:")) && /NeedsLabTag/.test(s.Sid));
  assert.ok(dyn.length >= 2 && dyn.every((s) => JSON.stringify(s.NotResource) === JSON.stringify(NAMED_TABLES)), JSON.stringify(dyn.map((s) => s.Sid)));
  assert.ok(CREATE_TAG_EXEMPT.includes("ec2:CopyImage"));
});

test("Review Focus 1: a replica table named lab-* is allowed untagged in Ireland; another table is refused; P8's load balancers", { skip }, () => {
  const { POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const IE = { "aws:RequestedRegion": "eu-west-1" };
  for (const a of ["dynamodb:CreateTable", "dynamodb:CreateTableReplica", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) assert.equal(d(a, `arn:aws:dynamodb:eu-west-1:${A}:table/lab-saa-16-dr-pilot-light-orders`, IE), "allowed", a);
  assert.notEqual(d("dynamodb:CreateTable", `arn:aws:dynamodb:eu-west-1:${A}:table/orders`, IE), "allowed");
  assert.notEqual(d("dynamodb:DeleteTable", `arn:aws:dynamodb:eu-west-2:${A}:table/orders`, { "aws:RequestedRegion": "eu-west-2" }), "allowed");
  assert.equal(d("dynamodb:CreateTable", `arn:aws:dynamodb:eu-west-2:${A}:table/orders`, NEW), "allowed", "a tagged table of any name");
  assert.equal(d("ec2:CopyImage", "arn:aws:ec2:eu-west-1::image/*", IE), "allowed");
  assert.equal(d("ec2:CopyImage", "arn:aws:ec2:us-east-2::image/*", { "aws:RequestedRegion": "us-east-2" }), "explicitDeny", "never a third region");
  const lb = `arn:aws:elasticloadbalancing:eu-west-2:${A}:loadbalancer/a1b2c3`;
  const R = { "aws:RequestedRegion": "eu-west-2" };
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, [`aws:ResourceTag/${EKS_LB_TAG}`]: "owned" }), "allowed");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, LAB), "allowed");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, "aws:ResourceTag/kubernetes.io/cluster/someone-else": "owned" }), "explicitDeny");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, R), "explicitDeny");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, "aws:ResourceTag/wg-admin": "vpn", [`aws:ResourceTag/${EKS_LB_TAG}`]: "owned" }), "explicitDeny", "never the VPN server's");
});

test("ruling P1: 20 policies at most, at least 4 spare, each packed under POLICY_PACK", { skip }, () => {
  const { POLICIES } = files();
  assert.equal(ROLE_POLICIES_MAX, 20);
  assert.ok(POLICIES.role.length <= ROLE_POLICIES_MAX - 4, `${POLICIES.role.length} role policies`);
  for (const [i, d] of POLICIES.role.entries()) assert.ok(policySize(d, FILL) < POLICY_PACK, `role policy ${i + 1}: ${policySize(d, FILL)}`);
});

test("what labs 11–19 do is allowed: tagged creates, their changes, the roles they pass, the service-linked roles they need", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const arn = (svc, rest, region = "eu-west-2") => `arn:aws:${svc}:${region}:${A}:${rest}`;
  const pass = (name, svc) => allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/${name}`, { "iam:PassedToService": `${svc}.amazonaws.com` });
  // Lab 11: ElastiCache.
  allowed("elasticache:CreateReplicationGroup", arn("elasticache", "replicationgroup:ca11k3x9q"), NEW);
  allowed("elasticache:CreateCacheSubnetGroup", arn("elasticache", "subnetgroup:lab-saa-11-three-tier-cache"), NEW);
  allowed("elasticache:DeleteReplicationGroup", arn("elasticache", "replicationgroup:ca11k3x9q"), LAB);
  // Lab 12: Cognito, DynamoDB, the API's integration permission.
  allowed("cognito-idp:CreateUserPool", "*", NEW);
  for (const a of ["cognito-idp:CreateUserPoolClient", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:DeleteUserPool"]) allowed(a, arn("cognito-idp", "userpool/eu-west-2_AbCdEf"), LAB);
  allowed("dynamodb:CreateTable", arn("dynamodb", "table/lab-saa-12-serverless-api-items"), NEW);
  // Lab 13: queues, topic, bus, state machine, the roles they pass.
  for (const [a, r] of [["sqs:CreateQueue", "lab-saa-13-decoupling-billing"], ["sns:CreateTopic", "lab-saa-13-decoupling-orders"], ["events:CreateEventBus", "event-bus/lab-saa-13-decoupling-bus"], ["states:CreateStateMachine", "stateMachine:lab-saa-13-decoupling-orders"]]) allowed(a, arn(a.split(":")[0], r), NEW);
  for (const [a, r] of [["sqs:SetQueueAttributes", "lab-saa-13-decoupling-billing"], ["sns:Subscribe", "lab-saa-13-decoupling-orders"], ["events:PutTargets", "rule/lab-saa-13-decoupling-bus/lab-saa-13-decoupling-placed"], ["states:DeleteStateMachine", "stateMachine:lab-saa-13-decoupling-orders"]]) allowed(a, arn(a.split(":")[0], r), LAB);
  pass("lab-saa-13-decoupling-sfn", "states");
  pass("lab-saa-13-decoupling-events", "events");
  // Lab 14: EFS and its mount targets; the service-linked role.
  allowed("elasticfilesystem:CreateFileSystem", arn("elasticfilesystem", "file-system/*"), NEW);
  allowed("elasticfilesystem:CreateMountTarget", arn("elasticfilesystem", "file-system/fs-0abc"), LAB);
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/elasticfilesystem.amazonaws.com/AWSServiceRoleForAmazonElasticFileSystem`, { "iam:AWSServiceName": "elasticfilesystem.amazonaws.com" });
  // Lab 16: Ireland, the replication role, the DynamoDB replication service-linked role, Route 53 in us-east-1.
  allowed("ec2:CreateVpc", arn("ec2", "vpc/*", "eu-west-1"), { ...NEW, "aws:RequestedRegion": "eu-west-1" });
  pass("lab-saa-16-dr-pilot-light-replication", "s3");
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/replication.dynamodb.amazonaws.com/AWSServiceRoleForDynamoDBReplication`, { "iam:AWSServiceName": "replication.dynamodb.amazonaws.com" });
  for (const a of ["route53:CreateHostedZone", "route53:AssociateVPCWithHostedZone", "route53:CreateHealthCheck"]) allowed(a, "*", { "aws:RequestedRegion": "us-east-1" });
  // Lab 17: Kinesis, Firehose, Glue, Athena.
  for (const [a, r] of [["kinesis:CreateStream", "stream/lab-saa-17-data-pipeline-events"], ["firehose:CreateDeliveryStream", "deliverystream/lab-saa-17-data-pipeline-to-s3"], ["glue:CreateDatabase", "database/lab_saa_17_data_pipeline"], ["glue:CreateCrawler", "crawler/lab-saa-17-data-pipeline-events"], ["athena:CreateWorkGroup", "workgroup/lab-saa-17-data-pipeline-wg"]]) allowed(a, arn(a.split(":")[0], r), NEW);
  for (const [a, r] of [["kinesis:DeleteStream", "stream/lab-saa-17-data-pipeline-events"], ["glue:DeleteCrawler", "crawler/lab-saa-17-data-pipeline-events"], ["athena:DeleteWorkGroup", "workgroup/lab-saa-17-data-pipeline-wg"]]) allowed(a, arn(a.split(":")[0], r), LAB);
  allowed("glue:DeleteDatabase", arn("glue", "database/lab_saa_17_data_pipeline"), { "aws:RequestedRegion": "eu-west-2" });
  pass("lab-saa-17-data-pipeline-firehose", "firehose");
  pass("lab-saa-17-data-pipeline-crawler", "glue");
  // Lab 18: the Spot service-linked role. Lab 19: EKS, its roles.
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot`, { "iam:AWSServiceName": "spot.amazonaws.com" });
  allowed("eks:CreateCluster", arn("eks", "cluster/lab-saa-19-eks"), NEW);
  allowed("eks:CreateNodegroup", arn("eks", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/*"), NEW);
  for (const [a, r] of [["eks:DeleteNodegroup", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/0abc"], ["eks:DeleteCluster", "cluster/lab-saa-19-eks"]]) allowed(a, arn("eks", r), LAB);
  pass("lab-saa-19-eks-cluster", "eks");
  pass("lab-saa-19-eks-node", "ec2");
  allowed("iam:AttachRolePolicy", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-saa-19-eks-cluster`, { ...BOUNDED, "iam:PolicyARN": "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy" });
});

test("ruling P22: a lab may delete an untagged network interface in its VPC (EFS mount targets); the VPN server's and the default VPC's stay refused", { skip }, () => {
  const { POLICIES } = files();
  const eni = `arn:aws:ec2:eu-west-2:${A}:network-interface/eni-0123456789abcdef0`;
  const R = { "aws:RequestedRegion": "eu-west-2" };
  for (const [who, docs] of [["role", POLICIES.role], ["boundary", [POLICIES.boundary]]]) {
    assert.equal(decide(docs, { action: "ec2:DeleteNetworkInterface", resource: eni, ctx: R }), "allowed", `${who}: an untagged lab-VPC ENI`);
    assert.notEqual(decide(docs, { action: "ec2:DeleteNetworkInterface", resource: eni, ctx: { ...R, "aws:ResourceTag/wg-admin": "vpn" } }), "allowed", `${who}: the VPN server's ENI`);
    assert.notEqual(decide(docs, { action: "ec2:DeleteNetworkInterface", resource: eni, ctx: { ...R, "ec2:Vpc": FILL.vpcArns[0] } }), "allowed", `${who}: a default-VPC ENI`);
  }
});

test("Review Focus 1 / P3: an untagged accepter side is accepted in a lab VPC; never into a VPC without the lab tag or the VPN server's", { skip }, () => {
  const { ABAC, POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const IE = { "aws:RequestedRegion": "eu-west-1" };
  assert.ok(CHANGE_TAG_EXEMPT.includes("ec2:AcceptVpcPeeringConnection") && CHANGE_TAG_EXEMPT.includes("ec2:AcceptTransitGatewayPeeringAttachment"));
  const coversIt = (x) => (a) => a.toLowerCase() === x.toLowerCase() || (a.endsWith("*") && x.toLowerCase().startsWith(a.slice(0, -1).toLowerCase()));
  for (const x of ["ec2:AcceptVpcPeeringConnection", "ec2:AcceptTransitGatewayPeeringAttachment"]) assert.ok(!ABAC.change.some(coversIt(x)), `no change-list entry covers ${x}`);
  assert.equal(d("ec2:AcceptTransitGatewayPeeringAttachment", `arn:aws:ec2:eu-west-1:${A}:transit-gateway-attachment/tgw-attach-0abc`, IE), "allowed");
  // Fix round 1: AWS gives the peering's ec2:RequesterVpc; PeeringAcceptOwnAccountOnly needs it in this account.
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc-peering-connection/pcx-0abc`, { ...IE, "ec2:RequesterVpc": `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0def` }), "allowed", "the accepter side's peering, untagged");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc/vpc-0abc`, { ...IE, "aws:ResourceTag/cloudlabs-lab": "ans-29-multi-region" }), "allowed");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc/vpc-0abc`, IE), "explicitDeny", "VpcFabricNeedsLabTag on the accepter VPC");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0abc`, { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/cloudlabs-lab": "x", "aws:ResourceTag/wg-admin": "vpn" }), "explicitDeny");
  assert.equal(d("ec2:AcceptTransitGatewayVpcAttachment", `arn:aws:ec2:eu-west-2:${A}:transit-gateway-attachment/tgw-attach-0abc`, { "aws:RequestedRegion": "eu-west-2" }), "explicitDeny", "other accepts still need the tag");
});

test("ruling P8: logs resource policies are denied; ruling P4: batch 4's service-linked roles", { skip }, () => {
  const { POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  for (const a of ["logs:PutResourcePolicy", "logs:DeleteResourcePolicy"]) assert.equal(d(a, "*", { "aws:RequestedRegion": "eu-west-2" }), "explicitDeny", a);
  for (const s of ["ipam", "clientvpn", "route53resolver", "transitgateway", "network-firewall", "globalaccelerator", "vpc-lattice"]) assert.ok(SERVICE_LINKED.includes(`${s}.amazonaws.com`), s);
});

test("what labs 20–31 do is allowed: tagged creates, their changes, the global services, the roles they pass, vended log delivery", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const ec2 = (rest, region = "eu-west-2") => `arn:aws:ec2:${region}:${A}:${rest}`;
  // Lab 20: IPAM, the IPv6 pool, the association, egress-only gateway, prefix list.
  allowed("ec2:CreateIpam", `arn:aws:ec2::${A}:ipam/*`, NEW);
  allowed("ec2:CreateIpamPool", `arn:aws:ec2::${A}:ipam-pool/*`, NEW);
  allowed("ec2:ProvisionIpamPoolCidr", `arn:aws:ec2::${A}:ipam-pool/ipam-pool-0abc`, LAB);
  allowed("ec2:AssociateVpcCidrBlock", ec2("vpc/vpc-0abc"), LAB);
  allowed("ec2:AssociateVpcCidrBlock", `arn:aws:ec2::${A}:ipam-pool/ipam-pool-0abc`, LAB);
  for (const [a, t] of [["ec2:CreateEgressOnlyInternetGateway", "egress-only-internet-gateway"], ["ec2:CreateManagedPrefixList", "prefix-list"]]) allowed(a, ec2(`${t}/*`), NEW);
  // Labs 21, 27, 29: transit gateways.
  for (const [a, t] of [["ec2:CreateTransitGateway", "transit-gateway"], ["ec2:CreateTransitGatewayVpcAttachment", "transit-gateway-attachment"], ["ec2:CreateTransitGatewayRouteTable", "transit-gateway-route-table"], ["ec2:CreateTransitGatewayPeeringAttachment", "transit-gateway-attachment"]]) allowed(a, ec2(`${t}/*`), NEW);
  for (const [a, t] of [["ec2:CreateTransitGatewayRoute", "transit-gateway-route-table/tgw-rtb-0abc"], ["ec2:AssociateTransitGatewayRouteTable", "transit-gateway-attachment/tgw-attach-0abc"], ["ec2:DeleteTransitGateway", "transit-gateway/tgw-0abc"]]) allowed(a, ec2(t), LAB);
  // Lab 22: VPN.
  for (const [a, t] of [["ec2:CreateVpnGateway", "vpn-gateway"], ["ec2:CreateCustomerGateway", "customer-gateway"], ["ec2:CreateVpnConnection", "vpn-connection"]]) allowed(a, ec2(`${t}/*`), NEW);
  for (const [a, t] of [["ec2:AttachVpnGateway", "vpn-gateway/vgw-0abc"], ["ec2:EnableVgwRoutePropagation", "route-table/rtb-0abc"], ["ec2:DeleteVpnConnection", "vpn-connection/vpn-0abc"]]) allowed(a, ec2(t), LAB);
  // Labs 23: Resolver; 27: Network Firewall; 30: Lattice; 25, 31: ACM.
  for (const a of ["route53resolver:CreateResolverEndpoint", "route53resolver:CreateResolverRule", "route53resolver:CreateFirewallDomainList", "route53resolver:CreateFirewallRuleGroup", "route53resolver:CreateResolverQueryLogConfig", "network-firewall:CreateFirewall", "network-firewall:CreateFirewallPolicy", "network-firewall:CreateRuleGroup", "vpc-lattice:CreateServiceNetwork", "vpc-lattice:CreateService", "vpc-lattice:CreateTargetGroup", "acm:ImportCertificate"]) allowed(a, "*", NEW);
  for (const [a, r] of [["route53resolver:AssociateResolverRule", `arn:aws:route53resolver:eu-west-2:${A}:resolver-rule/rslvr-rr-0abc`], ["network-firewall:UpdateLoggingConfiguration", `arn:aws:network-firewall:eu-west-2:${A}:firewall/lab-x`], ["vpc-lattice:RegisterTargets", `arn:aws:vpc-lattice:eu-west-2:${A}:targetgroup/tg-0abc`], ["vpc-lattice:PutAuthPolicy", `arn:aws:vpc-lattice:eu-west-2:${A}:service/svc-0abc`], ["acm:DeleteCertificate", `arn:aws:acm:eu-west-2:${A}:certificate/0abc`]]) allowed(a, r, LAB);
  // Lab 31: Client VPN; lab 28: mirroring and the flow-log role; lab 24, 25: endpoint services.
  allowed("ec2:CreateClientVpnEndpoint", ec2("client-vpn-endpoint/*"), NEW);
  allowed("ec2:AssociateClientVpnTargetNetwork", ec2("client-vpn-endpoint/cvpn-endpoint-0abc"), LAB);
  for (const [a, t] of [["ec2:CreateTrafficMirrorTarget", "traffic-mirror-target"], ["ec2:CreateTrafficMirrorFilter", "traffic-mirror-filter"], ["ec2:CreateVpcEndpointServiceConfiguration", "vpc-endpoint-service"]]) allowed(a, ec2(`${t}/*`), NEW);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-ans-28-flow-logs-fix-flowlogs`, { "iam:PassedToService": "vpc-flow-logs.amazonaws.com" });
  // Ruling P17: the filter rule carries no tags (the provider has none), so it is create-tag exempt; its filter is the lab's.
  assert.ok(CREATE_TAG_EXEMPT.includes("ec2:CreateTrafficMirrorFilterRule"));
  allowed("ec2:CreateTrafficMirrorFilterRule", ec2("traffic-mirror-filter-rule/*"), { "aws:RequestedRegion": "eu-west-2" });
  allowed("ec2:CreateTrafficMirrorFilterRule", ec2("traffic-mirror-filter/tmf-0abc"), LAB);
  // Ruling P8: vended logs (labs 23, 27, 28) to the lab's bucket: the delivery and the bucket's own policy; lab 22's EIP.
  for (const a of ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries"]) allowed(a, "*", { "aws:RequestedRegion": "eu-west-2" });
  for (const a of ["s3:GetBucketPolicy", "s3:PutBucketPolicy"]) allowed(a, "arn:aws:s3:::cloudlabs-a23k3x9q-dnslogs", { "aws:RequestedRegion": "eu-west-2" });
  assert.notEqual(decide(POLICIES.role, { action: "s3:PutBucketPolicy", resource: "arn:aws:s3:::someone-elses-bucket", ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed");
  allowed("ec2:AssociateAddress", ec2("elastic-ip/eipalloc-0abc"), LAB);
  // Lab 26: the global services in their regions.
  allowed("globalaccelerator:CreateAccelerator", "*", { "aws:RequestedRegion": "us-west-2" });
  allowed("cloudfront:CreateFunction", "*", { "aws:RequestedRegion": "us-east-1" });
  allowed("wafv2:CreateWebACL", `arn:aws:wafv2:us-east-1:${A}:global/webacl/lab-ans-26-edge-waf/*`, { ...NEW, "aws:RequestedRegion": "us-east-1" });
  assert.notEqual(decide(POLICIES.role, { action: "globalaccelerator:CreateAccelerator", resource: "*", ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed", "Global Accelerator answers only in us-west-2 (V)");
});

test("Task 2 fix round 1, P17: a mirror filter rule's create, modify and delete are judged by its filter's lab tag, not the untagged rule's", { skip }, () => {
  const { ABAC, POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const R = { "aws:RequestedRegion": "eu-west-2" };
  const rule = `arn:aws:ec2:eu-west-2:${A}:traffic-mirror-filter-rule/tmfr-0abc`;
  const filter = `arn:aws:ec2:eu-west-2:${A}:traffic-mirror-filter/tmf-0abc`;
  const coversIt = (x) => (a) => a.toLowerCase() === x.toLowerCase() || (a.endsWith("*") && x.toLowerCase().startsWith(a.slice(0, -1).toLowerCase()));
  for (const a of ["ec2:CreateTrafficMirrorFilterRule", "ec2:DeleteTrafficMirrorFilterRule", "ec2:ModifyTrafficMirrorFilterRule"]) {
    assert.ok(![...ABAC.create, ...ABAC.change].some(coversIt(a)), `no list entry covers ${a}`);
    assert.equal(d(a, rule, R), "allowed", `${a}: the untagged rule`);
    assert.equal(d(a, filter, R), "explicitDeny", `${a}: an untagged filter`);
    assert.equal(d(a, filter, { ...R, "aws:ResourceTag/cloudlabs-lab": "ans-28-flow-logs-fix" }), "allowed", `${a}: the lab's filter`);
    assert.equal(d(a, filter, { ...R, "aws:ResourceTag/cloudlabs-lab": "x", "aws:ResourceTag/wg-admin": "vpn" }), "explicitDeny", `${a}: never the VPN server's`);
  }
  // The filter's own delete still needs the lab tag.
  assert.equal(d("ec2:DeleteTrafficMirrorFilter", filter, R), "explicitDeny");
});

test("Task 2 fix rounds 1 and 2, P3: the VPC peering accept is refused for another account's requester VPC, and not judged without one", { skip }, () => {
  const { POLICIES } = files();
  const d = (ctx) => decide(POLICIES.role, { action: "ec2:AcceptVpcPeeringConnection", resource: `arn:aws:ec2:eu-west-1:${A}:vpc-peering-connection/pcx-0abc`, ctx: { "aws:RequestedRegion": "eu-west-1", ...ctx } });
  assert.equal(d({ "ec2:RequesterVpc": `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0def` }), "allowed", "same account");
  assert.equal(d({ "ec2:RequesterVpc": "arn:aws:ec2:eu-west-2:999999999999:vpc/vpc-0def" }), "explicitDeny", "another account's requester");
  // Fix round 2: without the key the statement does not apply (soa-08's in-lab accept, released, must keep working).
  assert.equal(d({}), "allowed", "no requester given: not refused by this statement");
  // The accepter VPC (no RequesterVpc on it) is still judged by VpcFabricNeedsLabTag alone.
  assert.equal(decide(POLICIES.role, { action: "ec2:AcceptVpcPeeringConnection", resource: `arn:aws:ec2:eu-west-1:${A}:vpc/vpc-0abc`, ctx: { "aws:RequestedRegion": "eu-west-1", "aws:ResourceTag/cloudlabs-lab": "ans-29-multi-region" } }), "allowed");
});

test("Task 2 fix round 1, P8: the boundary refuses CloudWatch Logs' account resource policy too", { skip }, () => {
  const { POLICIES } = files();
  for (const a of ["logs:PutResourcePolicy", "logs:DeleteResourcePolicy"]) assert.equal(decide([POLICIES.boundary], { action: a, resource: "*", ctx: { "aws:RequestedRegion": "eu-west-2" } }), "explicitDeny", a);
  // A lab role still writes to its own log groups.
  assert.equal(decide([POLICIES.boundary], { action: "logs:PutLogEvents", resource: `arn:aws:logs:eu-west-2:${A}:log-group:/cloudlabs/x/app:log-stream:s`, ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed");
});

test("ans-21 fix: a transit gateway route's create, replace and delete are judged by its route table's lab tag (a blackhole route is authorised on every attachment)", { skip }, () => {
  const { ABAC, POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const R = { "aws:RequestedRegion": "eu-west-2" };
  const table = `arn:aws:ec2:eu-west-2:${A}:transit-gateway-route-table/tgw-rtb-0abc`;
  const anyAttachment = `arn:aws:ec2:eu-west-2:${A}:transit-gateway-attachment/*`;
  const coversIt = (x) => (a) => a.toLowerCase() === x.toLowerCase() || (a.endsWith("*") && x.toLowerCase().startsWith(a.slice(0, -1).toLowerCase()));
  for (const a of ["ec2:CreateTransitGatewayRoute", "ec2:ReplaceTransitGatewayRoute", "ec2:DeleteTransitGatewayRoute"]) {
    assert.ok(!ABAC.change.some(coversIt(a)), `no change-list entry covers ${a}`);
    // Run 39026046930's blackhole route: AWS asks on the lab's tagged route table and on the untagged wildcard attachment.
    assert.equal(d(a, table, { ...R, "aws:ResourceTag/cloudlabs-lab": "ans-21-transit-gateway" }), "allowed", `${a}: the lab's route table`);
    assert.equal(d(a, anyAttachment, R), "allowed", `${a}: a blackhole route's wildcard attachment`);
    assert.equal(d(a, table, R), "explicitDeny", `${a}: an untagged route table`);
    assert.equal(d(a, table, { ...R, "aws:ResourceTag/cloudlabs-lab": "x", "aws:ResourceTag/wg-admin": "vpn" }), "explicitDeny", `${a}: never the VPN server's route table`);
    // A route naming the VPN server's attachment: DenyVpnServer refuses it on the attachment.
    assert.equal(d(a, `arn:aws:ec2:eu-west-2:${A}:transit-gateway-attachment/tgw-attach-0vpn`, { ...R, "aws:ResourceTag/wg-admin": "vpn" }), "explicitDeny", `${a}: never the VPN server's attachment`);
  }
  // The route table itself and its announcements still need the lab tag (the change list, split around the routes).
  for (const a of ["ec2:DeleteTransitGatewayRouteTable", "ec2:DeleteTransitGatewayRouteTableAnnouncement"]) assert.equal(d(a, table, R), "explicitDeny", a);
  assert.equal(d("ec2:DeleteTransitGatewayRouteTable", table, { ...R, "aws:ResourceTag/cloudlabs-lab": "ans-21-transit-gateway" }), "allowed");
});

test("ans-26 fix: a WAF create needs the lab's request tag only on the item it makes (a web ACL is authorised on the managed rule sets and rule groups it uses)", { skip }, () => {
  const { ABAC, POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const E = { "aws:RequestedRegion": "us-east-1" };
  const TAGGED = { ...E, "aws:RequestTag/cloudlabs-lab": "ans-26-edge", "aws:TagKeys": ["cloudlabs-lab", "Name"] };
  const waf = (rest) => `arn:aws:wafv2:us-east-1:${A}:global/${rest}`;
  const own = { "wafv2:CreateWebACL": "webacl", "wafv2:CreateRuleGroup": "rulegroup", "wafv2:CreateIPSet": "ipset", "wafv2:CreateRegexPatternSet": "regexpatternset" };
  // What each create is also authorised on (the reference's resources for it), besides the type it makes.
  const uses = { "wafv2:CreateWebACL": ["ipset", "managedruleset", "regexpatternset", "rulegroup"], "wafv2:CreateRuleGroup": ["ipset", "regexpatternset"], "wafv2:CreateIPSet": [], "wafv2:CreateRegexPatternSet": [] };
  for (const [a, type] of Object.entries(own)) {
    assert.ok(ABAC.create.includes(a), `${a} is still a create`);
    // Grouped with other per-type creates (A29), but never refused on a type it uses without making it.
    const on = ABAC.createOn[a] ?? [];
    assert.ok(on.includes(`arn:aws:wafv2:*:*:*/${type}/*/*`), `${a}: refused without the tag on its own type`);
    for (const t of uses[a]) assert.ok(!on.some((x) => x.includes(`/${t}/`)), `${a}: not refused on a ${t} it uses`);
    assert.equal(d(a, waf(`${type}/lab-ans-26-edge-x/*`), TAGGED), "allowed", `${a}: tagged`);
    assert.equal(d(a, waf(`${type}/lab-ans-26-edge-x/*`), E), "explicitDeny", `${a}: untagged`);
  }
  // Run 39027988912: AWS also asks CreateWebACL on the AWS managed rule set (and any rule group, IP set or pattern set)
  // the ACL uses, with no request tag in that resource's context.
  assert.equal(d("wafv2:CreateWebACL", waf("managedruleset/AWSManagedRulesCommonRuleSet/0abc"), E), "allowed", "the managed rule set");
  for (const t of ["rulegroup", "ipset", "regexpatternset"]) assert.equal(d("wafv2:CreateWebACL", waf(`${t}/lab-ans-26-edge-x/0abc`), E), "allowed", `a ${t} the ACL uses`);
  assert.equal(d("wafv2:CreateRuleGroup", waf("ipset/lab-ans-26-edge-x/0abc"), E), "allowed", "an IP set the rule group uses");
  // The region rule stays: GlobalServices only in us-east-1 and us-west-2.
  assert.notEqual(d("wafv2:CreateWebACL", `arn:aws:wafv2:eu-central-1:${A}:regional/webacl/lab-x/*`, { ...TAGGED, "aws:RequestedRegion": "eu-central-1" }), "allowed", "a third region");
});
