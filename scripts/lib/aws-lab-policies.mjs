// scripts/lib/aws-lab-policies.mjs
//
// Plain English: what the AWS labs' own login, wg-admin-labs, may do, written
// as IAM policy documents (AWS labs spec §7.1 and §7.2). Pure: no files, no
// network. scripts/aws-labs-abac.mjs feeds it AWS's Service Authorization
// Reference and writes what it returns to infra/aws-bootstrap/lab-abac.json
// and lab-policies.json; infra/aws-bootstrap/labs.tf turns those into the
// managed policies and the boundary.
//
// The ABAC lists (ruling P16/A46). The create list is every action of an
// allow-listed service that takes the request tag aws:RequestTag/${TagKey}:
// on the action itself (refused on any resource when cloudlabs-lab is not
// asked for), or, as EC2, ElastiCache and Kinesis say it, on the one resource
// type the action makes (refused on that type's ARNs only, so a subnet's VPC,
// which is already there and carries no request tag, is not refused).
// ec2:RunInstances is refused only on its instance and volume ARNs, the two
// Terraform tags (its network interface takes no tags from Terraform, V
// 2026-10-15). The change list is every write or permissions action, not
// tagging-only and not a list, with at least one resource type, every one of
// which accepts aws:ResourceTag/${TagKey} (the action's own keys for that
// type when the reference gives them), none AWS-owned (AWS_OWNED_TYPES), and
// not in the create list. An action on a type labs own by name because
// Terraform cannot tag it (NAME_OWNED_TYPES, lab-scope-aws.mjs UNTAGGABLE) is
// in neither list, or a lab could neither make nor remove it. Nor is a read
// (the reference gives a few reads the request tag), nor using a KMS key
// (KEY_USE: AWS's own untagged keys encrypt the labs' disks).
//
// Size (ruling A29). AWS caps a managed policy at 6,144 characters without
// whitespace and a role at 10 of them, so the statements are packed, first
// fit in order, into as few policies as fit under POLICY_MAX, a long list split over
// numbered statements (CreateNeedsLabTag1, 2, ...). foldWildcards writes
// "ec2:CreateVpc*" only where every action the wildcard matches (IAM matches
// without case) is in the same list. If even then the role would need more
// than 10, the change list falls back to <svc>:Delete*, Modify*, Update* and
// Terminate* for each ABAC service (but those of the untaggable named types),
// and the plan-time tag rule (§7.3) covers the rest.

import { AWS_LAB_REGIONS, AWS_GLOBAL_REGIONS, LAB_TAG, AWS_IAM_PATH, AWS_BOUNDARY } from "./labs.mjs";
import { MANAGED_POLICIES } from "../../infra/ci/lab-scope-aws.mjs";

export { MANAGED_POLICIES };
/** AWS's machine-readable Service Authorization Reference: a list of { service, url }. */
export const SAR_INDEX = "https://servicereference.us-east-1.amazonaws.com/";

/** §7.1's service allow-list, in the spec's order (servicequotas for reads only). */
export const LAB_SERVICES = [
  "ec2", "elasticloadbalancing", "autoscaling", "application-autoscaling", "ssm", "cloudwatch", "logs", "events", "scheduler", "sns", "sqs",
  "states", "lambda", "apigateway", "dynamodb", "cognito-idp", "rds", "elasticache", "backup", "backup-storage", "kms", "secretsmanager",
  "config", "cloudformation", "ecr", "ecs", "eks", "kinesis", "firehose", "glue", "athena", "route53resolver", "elasticfilesystem",
  "network-firewall", "vpc-lattice", "acm", "wafv2", "resource-groups", "tag", "access-analyzer", "servicequotas",
];
/** The services whose actions the ABAC lists cover: tagging, resource groups and quota reads make nothing to tag. */
export const ABAC_SERVICES = LAB_SERVICES.filter((s) => !["tag", "resource-groups", "servicequotas"].includes(s));
const svc = (x) => `${x}.amazonaws.com`;
/** iam:PassedToService: the services a lab role may be handed to. */
export const PASS_SERVICES = ["ec2", "lambda", "ecs-tasks", "eks", "states", "config", "backup", "ssm", "firehose", "glue", "vpc-flow-logs", "apigateway", "events", "scheduler", "s3", "cloudformation"].map(svc);
/** iam:AWSServiceName: the service-linked roles a lab may cause (ruling A18). */
export const SERVICE_LINKED = ["elasticloadbalancing", "autoscaling", "rds", "elasticache", "ecs", "eks", "eks-nodegroup", "network-firewall", "globalaccelerator", "backup", "config", "remediation.config", "transitgateway", "vpc-lattice", "ssm", "ec2-instance-connect"].map(svc);
/** Resource types AWS (or another account) owns: a change list action naming one would refuse e.g. launching from Amazon's AMI. */
export const AWS_OWNED_TYPES = ["ec2:image", "ec2:snapshot", "ec2:prefix-list", "ssm:document", "ssm:parameter"];
/** Types a lab owns by name (lab-<id>-*) because Terraform cannot tag them (lab-scope-aws.mjs UNTAGGABLE). */
export const NAME_OWNED_TYPES = ["cloudwatch:dashboard", "config:ConfigurationRecorder"];
/**
 * Using a KMS key is never refused on its tag: AWS's own keys (aws/ebs, aws/s3, aws/rds) carry no tags, and EC2, S3 and
 * RDS use them as the caller for every encrypted disk, bucket and database. Managing a key (deleting, disabling, its
 * policy) still needs the lab's tag.
 */
/**
 * Actions the reference says take a request tag but that are exempt from the create-needs-lab-tag rule (ruling A54).
 * EC2 Instance Connect Endpoints create their network interface with the caller's credentials and no tags, so
 * ec2:CreateNetworkInterface is in neither the create nor the change list. The VPN-server and default-VPC denies still
 * keep interfaces out of those networks, and Verify clean names any untagged interface left in a lab VPC (A26).
 */
export const CREATE_TAG_EXEMPT = ["ec2:CreateNetworkInterface"];
export const KEY_USE = /^kms:(Encrypt|Decrypt|ReEncrypt\w*|GenerateDataKey\w*|GenerateMac|VerifyMac|Sign|Verify|DeriveSharedSecret|CreateGrant|RetireGrant)$/;
/** Services with an untaggable named type: A29's fall-back gives them no wildcards. */
const NAME_OWNED_SERVICES = ["cloudwatch", "config", "logs", "kms"];
/** What ec2:RunInstances must tag: the two types Terraform's aws_instance tags (tags_all and volume_tags). */
export const RUN_INSTANCES_TYPES = ["instance", "volume"];
export const POLICY_MAX = 6000;
export const ROLE_POLICIES_MAX = 10;

const RT = "aws:RequestTag/${TagKey}";
const RS = "aws:ResourceTag/${TagKey}";
const ACCT = "__ACCOUNT__";
export const BOUNDARY_ARN = `arn:aws:iam::${ACCT}:policy/${AWS_BOUNDARY}`;
const IAM = (kind, name) => `arn:aws:iam::${ACCT}:${kind}${AWS_IAM_PATH}${name}`;
const LAB_ROLE = IAM("role", "lab-*");
const LAB_PROFILE = IAM("instance-profile", "lab-*");
const LAB_POLICY = IAM("policy", "lab-*");
const LAB07_USER = IAM("user", "lab-soa-07-*");
/** The size every policy is packed for: a 12-digit account and both regions' default VPCs (ruling C11). */
const PACK_FILL = { account: "123456789012", vpcArns: ["arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0123456789abcdef0", "arn:aws:ec2:eu-west-1:123456789012:vpc/vpc-0123456789abcdef0"] };

// ── The ABAC lists ────────────────────────────────────────────────────────

/** An ARN pattern from the reference's ARN format: arn:${Partition}:ec2:${Region}:${Account}:vpc/${VpcId} -> arn:aws:ec2:*:*:vpc/*. */
const arnPattern = (f) => f.replace(/\$\{Partition\}/g, "aws").replace(/\$\{[^}]+\}/g, "*");
/** The ARN patterns of one resource type (a guess from the type's name when the reference gives none). */
function arnsOf(service, top, type) {
  const f = top.get(type)?.ARNFormats;
  return f?.length ? [...new Set(f.map(arnPattern))] : [`arn:aws:${service}:*:*:${type}/*`];
}
const props = (a) => a.Annotations?.Properties ?? {};
const isUntag = (name) => /^(Untag|Remove\w*Tags?|Delete\w*Tags?)/.test(name);

/**
 * The create and change lists (P16) from each service's reference document, folded (A29), plus createOn: for each
 * create entry refused only on the types it makes, those types' ARN patterns; and untag: the tag-removing actions.
 */
export function abacLists(sar) {
  const create = [];
  const change = [];
  const untag = [];
  const accountSettings = [];
  const createOn = {};
  const allOf = {};
  const scoped = []; // { name, made: type keys, touches: type keys, arns }
  for (const service of ABAC_SERVICES) {
    const doc = sar[service];
    if (!doc) continue;
    const top = new Map((doc.Resources ?? []).map((r) => [r.Name, r]));
    const all = (allOf[service] = (doc.Actions ?? []).map((a) => `${service}:${a.Name}`));
    const actionLevel = [];
    const changes = [];
    const untags = [];
    for (const a of doc.Actions ?? []) {
      const p = props(a);
      const name = `${service}:${a.Name}`;
      const res = a.Resources ?? [];
      if (p.IsTaggingOnly) {
        if (isUntag(a.Name)) untags.push(name);
        continue;
      }
      if (res.some((r) => NAME_OWNED_TYPES.includes(`${service}:${r.Name}`))) continue;
      if (CREATE_TAG_EXEMPT.includes(name)) continue;
      if (isAccountSetting(service, a)) accountSettings.push(name);
      // A read makes nothing (the reference gives some reads the request tag): never in either list.
      if (!(p.IsWrite || p.IsPermissionManagement) || p.IsList) continue;
      const onAction = (a.ActionConditionKeys ?? []).includes(RT);
      const onTypes = res.filter((r) => (r.ConditionKeys ?? []).includes(RT)).map((r) => r.Name);
      const key = (t) => `${service}:${t}`;
      if (name === "ec2:RunInstances") {
        createOn[name] = RUN_INSTANCES_TYPES.flatMap((t) => arnsOf(service, top, t));
        create.push(name);
      } else if (onAction) {
        actionLevel.push(name);
      } else if (onTypes.length) {
        scoped.push({ name, made: onTypes.map(key), touches: res.map((r) => key(r.Name)), arns: onTypes.flatMap((t) => arnsOf(service, top, t)) });
      } else if (res.length > 0 && !KEY_USE.test(name)) {
        const tagged = (r) => (r.ConditionKeys ?? top.get(r.Name)?.ConditionKeys ?? []).includes(RS);
        if (res.every(tagged) && !res.some((r) => AWS_OWNED_TYPES.includes(key(r.Name)))) changes.push(name);
      }
    }
    create.push(...foldWildcards(actionLevel, all));
    change.push(...foldWildcards(changes, all));
    untag.push(...foldWildcards(untags, all));
  }
  // One statement may refuse several made types together (A29: fewer statements) only when no action in it touches a
  // type of the statement that it does not make: that resource carries no request tag and would be refused.
  const groups = [];
  for (const e of scoped.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const fitsIn = (g) => {
      const types = new Set([...g.types, ...e.made]);
      return [...g.members, e].every((m) => m.touches.every((t) => !types.has(t) || m.made.includes(t)));
    };
    const g = groups.find(fitsIn);
    if (g) {
      g.members.push(e);
      for (const t of e.made) g.types.add(t);
      for (const x of e.arns) g.arns.add(x);
    } else groups.push({ members: [e], types: new Set(e.made), arns: new Set(e.arns) });
  }
  for (const g of groups) {
    const arns = [...g.arns].sort();
    const byService = g.members.reduce((m, e) => m.set(e.name.split(":")[0], [...(m.get(e.name.split(":")[0]) ?? []), e]), new Map());
    for (const [service, members] of byService) {
      for (const f of foldWildcards(members.map((m) => m.name), allOf[service])) {
        createOn[f] = arns;
        create.push(f);
      }
    }
  }
  const sorted = (l) => [...new Set(l)].sort();
  return { create: sorted(create), change: sorted(change), createOn: Object.fromEntries(Object.keys(createOn).sort().map((k) => [k, createOn[k]])), untag: sorted(untag), accountSettings: sorted(accountSettings) };
}

/**
 * Account-wide EC2 settings (fix round 2): the VPN server lives under them too. VPC Block Public Access (its
 * bidirectional internet block would cut the server off), EBS encryption by default and its key (a redeployed server's
 * disk could take a lab key that is later deleted), instance metadata defaults, the serial console, image and snapshot
 * public-access blocks, allowed images and the like. From the reference (V 2026-10-15): every ec2 write with no
 * resource type named Enable*, Disable*, Modify*Default* or Reset*Default*, plus the named ones below.
 */
const ACCOUNT_SETTING_RE = /^(Enable|Disable|Modify\w*Default|Reset\w*Default)/;
export const NAMED_ACCOUNT_SETTINGS = ["ModifyVpcBlockPublicAccessOptions", "CreateVpcBlockPublicAccessExclusion", "ModifyVpcBlockPublicAccessExclusion", "DeleteVpcBlockPublicAccessExclusion", "ModifyAvailabilityZoneGroup", "ReplaceImageCriteriaInAllowedImagesSettings"];
/**
 * Account-wide SSM settings (final review, Important 3): every write on the reference's servicesetting type
 * (UpdateServiceSetting, ResetServiceSetting: V 2026-10-15, the type takes no tag), one of which is Default Host
 * Management, which would make every instance with the SSM agent, the VPN server's too, SSM-managed; and the region's
 * default patch baseline, which patches every managed instance outside a patch group. The reference has no SSM
 * setting write without a resource type (its resource-less writes make or cancel lab items).
 */
export const SSM_ACCOUNT_SETTING_TYPES = ["servicesetting"];
export const SSM_NAMED_ACCOUNT_SETTINGS = ["RegisterDefaultPatchBaseline"];
function isAccountSetting(service, a) {
  const p = props(a);
  if (service === "ssm") return Boolean(p.IsWrite || p.IsPermissionManagement) && (SSM_NAMED_ACCOUNT_SETTINGS.includes(a.Name) || (a.Resources ?? []).some((r) => SSM_ACCOUNT_SETTING_TYPES.includes(r.Name)));
  if (service !== "ec2") return false;
  if (NAMED_ACCOUNT_SETTINGS.includes(a.Name)) return true;
  return (a.Resources ?? []).length === 0 && Boolean(p.IsWrite || p.IsPermissionManagement) && ACCOUNT_SETTING_RE.test(a.Name);
}

/** Where a word starts in an action name (CreateVpcEndpoint: 6, 9; DescribeDBInstances: 8, 10). */
function wordStarts(name) {
  const at = [];
  for (let i = 1; i < name.length; i++) {
    const up = (c) => c >= "A" && c <= "Z";
    if (up(name[i]) && (!up(name[i - 1]) || (i + 1 < name.length && !up(name[i + 1]) && name[i + 1] >= "a"))) at.push(i);
  }
  return at;
}

/**
 * Shorter lists (A29): one service's actions as "svc:Prefix*" where the prefix ends on a word, the wildcard matches at
 * least two actions, and every action of the service it matches (IAM ignores case) is in `actions`. Shortest prefix first.
 */
export function foldWildcards(actions, allOfService) {
  const want = new Set(actions.map((a) => a.toLowerCase()));
  const all = allOfService.map((a) => a.toLowerCase());
  const out = [];
  const covered = new Set();
  for (const a of [...new Set(actions)].sort()) {
    if (covered.has(a.toLowerCase())) continue;
    const [service, name] = a.split(":");
    let folded = false;
    for (const end of [...wordStarts(name), name.length]) {
      const prefix = `${service}:${name.slice(0, end)}`.toLowerCase();
      const hits = all.filter((x) => x.startsWith(prefix));
      if (hits.length >= 2 && hits.every((x) => want.has(x))) {
        out.push(`${service}:${name.slice(0, end)}*`);
        for (const h of hits) covered.add(h);
        folded = true;
        break;
      }
    }
    if (!folded) out.push(a);
  }
  return out;
}

// ── The role's statements and the boundary ───────────────────────────────

const allow = (Sid, Action, Resource = "*", Condition) => ({ Sid, Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
const deny = (Sid, Action, Resource = "*", Condition) => ({ Sid, Effect: "Deny", Action, Resource, ...(Condition ? { Condition } : {}) });
const inRegions = (regions) => ({ StringEquals: { "aws:RequestedRegion": regions } });
const BOUNDED = { StringEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN } };
const LAB_SERVICE_ACTIONS = [...LAB_SERVICES.filter((s) => s !== "servicequotas").map((s) => `${s}:*`), "servicequotas:Get*", "servicequotas:List*"];
const GLOBAL_ACTIONS = ["cloudfront:*", "route53:*", "wafv2:*", "globalaccelerator:*", "tag:GetResources"];
/** IAM writes, as §7.1 and §7.2 list them. */
const IAM_WRITES = ["Create*", "Delete*", "Put*", "Attach*", "Detach*", "Update*", "Tag*", "Untag*", "Add*", "Remove*", "Set*", "PassRole"].map((x) => `iam:${x}`);

/**
 * Ruling A48, in the role and the boundary alike. Tags only at create (ec2:CreateAction) or on what already carries the
 * lab tag, so the tag cannot be put on someone else's item to make it the lab's; no DeleteTags without keys (it would
 * strip every tag, the lab's too, past KeepLabTag); and a VPC's network fabric (its ACLs, route tables, security groups
 * and the VPC itself) changes only when it carries the lab tag: AWS makes every VPC's default security group, network
 * ACL and main route table untagged, the VPN server's VPC's too.
 */
const VPC_FABRIC_ACTIONS = ["CreateRoute", "ReplaceRoute", "DeleteRoute", "CreateNetworkAclEntry", "ReplaceNetworkAclEntry", "DeleteNetworkAclEntry", "ReplaceNetworkAclAssociation", "DeleteNetworkAcl", "AssociateRouteTable", "DisassociateRouteTable", "ReplaceRouteTableAssociation", "DeleteRouteTable", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress", "RevokeSecurityGroupEgress", "ModifySecurityGroupRules", "UpdateSecurityGroupRuleDescriptionsIngress", "UpdateSecurityGroupRuleDescriptionsEgress", "DeleteSecurityGroup", "ModifyVpcAttribute", "DeleteVpc", "AttachInternetGateway", "DetachInternetGateway", "CreateSubnet", "AssociateVpcCidrBlock", "CreateVpcPeeringConnection", "AcceptVpcPeeringConnection"].map((a) => `ec2:${a}`);
const VPC_FABRIC_GUARDS = [
  // Network and compute items only (fix round 2): AWS Backup's service role tags the snapshots it makes after making them.
  deny("TagOnlyAtCreate", "ec2:CreateTags", ["network-acl", "route-table", "security-group", "vpc", "subnet", "internet-gateway", "network-interface", "instance"].map((t) => `arn:aws:ec2:*:*:${t}/*`), { Null: { "ec2:CreateAction": "true", [`aws:ResourceTag/${LAB_TAG}`]: "true" } }),
  deny("NoDeleteAllTags", "ec2:DeleteTags", "*", { Null: { "aws:TagKeys": "true" } }),
  deny("VpcFabricNeedsLabTag", VPC_FABRIC_ACTIONS, ["network-acl", "route-table", "security-group", "vpc"].map((t) => `arn:aws:ec2:*:*:${t}/*`), { Null: { [`aws:ResourceTag/${LAB_TAG}`]: "true" } }),
];
/** Every write to a Config recorder (V 2026-10-15: the reference's actions on ConfigurationRecorder). */
const RECORDER_WRITES = ["PutConfigurationRecorder", "StartConfigurationRecorder", "StopConfigurationRecorder", "DeleteConfigurationRecorder", "AssociateResourceTypes", "DisassociateResourceTypes", "DeleteServiceLinkedConfigurationRecorder"].map((a) => `config:${a}`);

/** §7.1's statements before the ABAC lists, in the table's order. */
function fixedStatements(abac) {
  return [
    allow("LabServices", LAB_SERVICE_ACTIONS, "*", inRegions(AWS_LAB_REGIONS)),
    allow("LabBuckets", "s3:*", ["arn:aws:s3:::cloudlabs-*", "arn:aws:s3:::cloudlabs-*/*"]),
    allow("BucketList", ["s3:ListAllMyBuckets", "s3:GetBucketLocation"]),
    allow("GlobalServices", GLOBAL_ACTIONS, "*", inRegions(AWS_GLOBAL_REGIONS)),
    allow("Identity", ["sts:GetCallerIdentity", "iam:Get*", "iam:List*"]),
    allow("LabRolesBounded", ["iam:CreateRole", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"], LAB_ROLE, BOUNDED),
    allow("LabRolesOther", ["iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:CreatePolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:TagPolicy"], [LAB_ROLE, LAB_PROFILE, LAB_POLICY]),
    allow("Lab07UsersBounded", ["iam:CreateUser", "iam:PutUserPermissionsBoundary", "iam:AttachUserPolicy", "iam:DetachUserPolicy", "iam:PutUserPolicy", "iam:DeleteUserPolicy"], LAB07_USER, BOUNDED),
    allow("Lab07UsersOther", ["iam:DeleteUser", "iam:TagUser", "iam:CreateLoginProfile", "iam:DeleteLoginProfile"], LAB07_USER),
    allow("PassLabRoles", "iam:PassRole", LAB_ROLE, { StringEquals: { "iam:PassedToService": PASS_SERVICES } }),
    allow("ServiceLinkedRoles", "iam:CreateServiceLinkedRole", "*", { StringEquals: { "iam:AWSServiceName": SERVICE_LINKED } }),
    deny("DenyVpnServer", "*", "*", { StringEquals: { "aws:ResourceTag/wg-admin": "vpn" } }),
    deny("DenyVpnTagRequest", "*", "*", { Null: { "aws:RequestTag/wg-admin": "false" } }),
    deny("DenyVpnTagKeys", "*", "*", { "ForAnyValue:StringEquals": { "aws:TagKeys": ["wg-admin"] } }),
    deny("DenyDefaultVpc", "ec2:*", "__DEFAULT_VPC_ARNS__"),
    deny("DenyDefaultVpcChildren", "ec2:*", "*", { ArnEquals: { "ec2:Vpc": "__DEFAULT_VPC_ARNS__" } }),
    ...VPC_FABRIC_GUARDS,
    // The untaggable named types (NAME_OWNED_TYPES): the lab's own names only, never the account's default recorder.
    { Sid: "LabDashboardsOnly", Effect: "Deny", Action: ["cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards"], NotResource: `arn:aws:cloudwatch::${ACCT}:dashboard/lab-*` },
    // soa-02's release test must confirm AWS evaluates PutConfigurationRecorder, at create, against the recorder's named
    // ARN (configuration-recorder/lab-<id>-*/...): if it asks on "*", this refuses the lab's own recorder.
    { Sid: "LabRecordersOnly", Effect: "Deny", Action: RECORDER_WRITES, NotResource: `arn:aws:config:*:${ACCT}:configuration-recorder/lab-*` },
    deny("DenyAccountAndBilling", ["organizations:*", "account:*", "billing:*", "aws-portal:*", "payments:*", "budgets:*", "cur:*", "ce:Create*", "ce:Update*", "ce:Delete*", "iam:*AccountPasswordPolicy", "iam:*AccountAlias", "iam:CreateAccessKey", "iam:*OpenIDConnectProvider*", "iam:*SAMLProvider*", "iam:*VirtualMFADevice", ...(abac.accountSettings ?? [])]),
    { Sid: "DenyIamOutsideLab", Effect: "Deny", Action: IAM_WRITES, NotResource: [LAB_ROLE, LAB_PROFILE, LAB_POLICY, LAB07_USER, `arn:aws:iam::${ACCT}:role/aws-service-role/*`] },
    deny("DenyBoundaryRemoval", ["iam:DeleteRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary"]),
    // §7.1's attachable list (lab-scope-aws.mjs MANAGED_POLICIES checks it at plan; this holds it at apply too).
    deny("AttachListedPoliciesOnly", ["iam:AttachRolePolicy", "iam:AttachUserPolicy"], "*", { ArnNotLike: { "iam:PolicyARN": [...MANAGED_POLICIES, LAB_POLICY] } }),
    deny("DenyOtherRoles", "sts:AssumeRole*"),
    { Sid: "DenyOtherRegions", Effect: "Deny", NotAction: ["iam:*", "sts:*", ...GLOBAL_ACTIONS, "s3:ListAllMyBuckets"], Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": [...AWS_LAB_REGIONS, ...AWS_GLOBAL_REGIONS] } } },
    // Not tag:* or wafv2:*, which GlobalServices gives in those two regions.
    deny("DenyGlobalRegionsForLabServices", LAB_SERVICE_ACTIONS.filter((a) => !/^(tag|wafv2):/.test(a)), "*", inRegions(AWS_GLOBAL_REGIONS)),
  ];
}

/** §7.2: the most any lab role or lab 07 user can do, whatever a lab attaches to it. */
export const WORKLOAD_SERVICES = ["ec2", "ssm", "ssmmessages", "ec2messages", "cloudwatch", "logs", "events", "sns", "sqs", "states", "lambda", "dynamodb", "kms", "secretsmanager", "s3", "ecr", "ecs", "eks", "elasticloadbalancing", "autoscaling", "kinesis", "firehose", "glue", "athena", "config", "backup", "rds", "elasticfilesystem", "vpc-lattice-svcs"];
function boundary(abac) {
  return {
    Version: "2012-10-17",
    Statement: [
      allow("Workload", WORKLOAD_SERVICES.map((s) => `${s}:*`), "*", inRegions(AWS_LAB_REGIONS)),
      allow("WhoAmI", "sts:GetCallerIdentity"),
      deny("NoIamWrites", [...IAM_WRITES, "iam:CreateAccessKey"]),
      deny("NoOtherRoles", "sts:AssumeRole*"),
      // Ruling A48: a lab's own roles (Lambda, EC2, SSM, Config remediation) are held as wg-admin-labs is.
      ...VPC_FABRIC_GUARDS,
      { Sid: "NoDefaultVpc", Effect: "Deny", NotAction: "ec2:Describe*", Resource: "__DEFAULT_VPC_ARNS__" },
      { Sid: "NoDefaultVpcChildren", Effect: "Deny", NotAction: "ec2:Describe*", Resource: "*", Condition: { ArnEquals: { "ec2:Vpc": "__DEFAULT_VPC_ARNS__" } } },
      deny("NoAccountOrBilling", ["organizations:*", "account:*", "billing:*", "aws-portal:*", "budgets:*", "ce:Create*", "ce:Update*", "ce:Delete*", ...(abac.accountSettings ?? [])]),
      deny("NoVpnServer", "*", "*", { StringEquals: { "aws:ResourceTag/wg-admin": "vpn" } }),
      deny("NoVpnTagRequest", "*", "*", { Null: { "aws:RequestTag/wg-admin": "false" } }),
      deny("NoVpnTagKeys", "*", "*", { "ForAnyValue:StringEquals": { "aws:TagKeys": ["wg-admin"] } }),
      { Sid: "NoOtherRegions", Effect: "Deny", NotAction: "sts:GetCallerIdentity", Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": AWS_LAB_REGIONS } } },
    ],
  };
}

// ── Sizes and packing ────────────────────────────────────────────────────

/** Characters AWS counts for a policy (whitespace excluded), with the placeholders filled as labs.tf fills them. */
export function policySize(doc, fill) {
  return (fill ? fillPolicy(doc, fill) : JSON.stringify(doc)).replace(/\s/g, "").length;
}
/** The document as labs.tf writes it: the account filled, and "__DEFAULT_VPC_ARNS__" an array of ARNs (ruling C11). */
export function fillPolicy(doc, fill) {
  return JSON.stringify(doc).split(ACCT).join(fill.account).split('"__DEFAULT_VPC_ARNS__"').join(JSON.stringify(fill.vpcArns));
}
const docOf = (Statement) => ({ Version: "2012-10-17", Statement });
const fits = (statements) => policySize(docOf(statements), PACK_FILL) < POLICY_MAX;

/**
 * The statements packed into policies (first fit: each goes into the first policy with room, a new one when none has).
 * A list statement (`list` set) is cut into numbered slices, each as long as the policy it goes into can hold:
 * `sid(n)` names slice n.
 */
function pack(items) {
  const docs = [];
  for (const it of items) {
    if (!it.list) {
      const d = docs.find((x) => fits([...x, it.statement]));
      if (d) d.push(it.statement);
      else docs.push([it.statement]);
      continue;
    }
    let left = [...it.list];
    while (left.length) {
      // The first policy that holds at least one more action, and as many as it holds; else a new policy.
      const room = (d) => {
        let n = 0;
        while (n < left.length && fits([...d, it.make(left.slice(0, n + 1), it.next())])) n++;
        return n;
      };
      let d = docs.find((x) => room(x) > 0);
      if (!d) {
        d = [];
        docs.push(d);
        if (room(d) === 0) throw new Error(`${left[0]}: one action does not fit a policy`);
      }
      const n = room(d);
      d.push(it.make(left.slice(0, n), it.take()));
      left = left.slice(n);
    }
  }
  return docs.map(docOf);
}

/** A numbered list statement: CreateNeedsLabTag1, 2, ... */
function counter(prefix) {
  let n = 0;
  return { next: () => `${prefix}${n + 1}`, take: () => `${prefix}${++n}` };
}

/** <svc>:Delete*, Modify*, Update*, Terminate* for each ABAC service without an untaggable named type (A29). */
export const changeFallback = () => ABAC_SERVICES.filter((s) => !NAME_OWNED_SERVICES.includes(s)).flatMap((s) => ["Delete*", "Modify*", "Update*", "Terminate*"].map((v) => `${s}:${v}`));

function roleItems(abac, change) {
  const createOn = abac.createOn ?? {};
  // Ruling A54: the exempt actions are in neither list, whatever lab-abac.json says.
  abac = { ...abac, create: abac.create.filter((a) => !CREATE_TAG_EXEMPT.includes(a)) };
  const noRequestTag = { Null: { [`aws:RequestTag/${LAB_TAG}`]: "true" } };
  const creates = counter("CreateNeedsLabTag");
  const changes = counter("ChangeNeedsLabTag");
  const items = fixedStatements(abac).map((statement) => ({ statement }));
  // Requested on the action: refused on any resource.
  const anywhere = abac.create.filter((a) => !createOn[a]);
  items.push({ list: anywhere, ...creates, make: (Action, Sid) => deny(Sid, Action, "*", noRequestTag) });
  // Requested on the type made: refused on that type's ARNs only, one statement per set of types.
  const groups = new Map();
  for (const a of abac.create.filter((x) => createOn[x] && x !== "ec2:RunInstances")) {
    const key = JSON.stringify(createOn[a]);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const [key, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const arns = JSON.parse(key);
    items.push({ list, ...creates, make: (Action, Sid) => deny(Sid, Action, arns.length === 1 ? arns[0] : arns, noRequestTag) });
  }
  if (abac.create.includes("ec2:RunInstances")) {
    const on = createOn["ec2:RunInstances"] ?? RUN_INSTANCES_TYPES.map((t) => `arn:aws:ec2:*:*:${t}/*`);
    items.push({ statement: deny("CreateNeedsLabTagRunInstances", "ec2:RunInstances", on, noRequestTag) });
  }
  const changeCond = (Action) => ({ Null: { [`aws:ResourceTag/${LAB_TAG}`]: "true", ...(Action.some((a) => a.startsWith("ec2:")) ? { "ec2:CreateAction": "true" } : {}) } });
  items.push({ list: change, ...changes, make: (Action, Sid) => deny(Sid, Action, "*", changeCond(Action)) });
  const untag = abac.untag ?? ABAC_SERVICES.map((s) => `${s}:Untag*`).concat("ec2:DeleteTags");
  items.push({ statement: deny("KeepLabTag", [...new Set(["tag:UntagResources", ...untag])].sort(), "*", { "ForAnyValue:StringEquals": { "aws:TagKeys": [LAB_TAG] } }) });
  return items;
}

/**
 * The role's managed policies and the boundary, from lab-abac.json's lists. Placeholders: __ACCOUNT__, and
 * "__DEFAULT_VPC_ARNS__" (a JSON string that labs.tf replaces with an array of ARNs, ruling C11).
 * `changeFallback` is true when A29's fall-back was needed.
 */
export function renderLabPolicies(abac) {
  let role = pack(roleItems(abac, abac.change));
  let fallback = false;
  if (role.length > ROLE_POLICIES_MAX) {
    role = pack(roleItems(abac, changeFallback()));
    fallback = true;
    if (role.length > ROLE_POLICIES_MAX) throw new Error(`the role needs ${role.length} policies even with A29's fall-back`);
  }
  const out = { role, boundary: boundary(abac) };
  Object.defineProperty(out, "changeFallback", { value: fallback, enumerable: false });
  return out;
}
