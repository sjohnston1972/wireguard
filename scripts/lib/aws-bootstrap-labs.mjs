// scripts/lib/aws-bootstrap-labs.mjs
//
// Plain English: the AWS labs' part of the one-off AWS setup (node
// scripts/aws-bootstrap.mjs --labs; AWS labs spec §7.1, §13, rulings A19 and
// A23), run after Terraform has made wg-admin-labs and its boundary:
//   1. asks IAM's policy simulator about wg-admin-labs (ruling A19's eight:
//      may it make a tagged VPC and a bounded lab role; is it refused an
//      untagged VPC, the VPN server, a role without the boundary or off the
//      path, an access key and a third region; and ruling A48's: tags and VPC
//      network changes only on lab-tagged items, never the VPN server's user
//      data, the deploy role, AdministratorAccess, the boundary itself or the
//      default VPC; and the final review's: no launch with an untagged volume,
//      no SSM account setting), then about wg-admin-lab-boundary as a policy of its own
//      (simulate-custom-policy), and fails loudly on any other answer
//   2. reads the lab quotas (London and Ireland; IAM's in us-east-1) and asks
//      for more where they are below target (never twice: a pending request is
//      left alone)
//   3. reports the cost allocation tag cloudlabs-lab, switching it on when
//      billing has seen it but it is off
// The aws command runner is passed in (the tests give a fake). Only names,
// numbers and AWS's error codes are printed: never an ARN or the account id.

import { AWS_LAB_REGIONS, LAB_TAG, AWS_BOUNDARY } from "./labs.mjs";
import { SERVICE_LINKED } from "./aws-lab-policies.mjs";

const ctx = (key, values, type = "string") => ({ key, type, values });

/**
 * Ruling A19's cases and fix round 1's (ruling A48), asked of the role with `aws iam simulate-principal-policy`.
 * defaultVpcArns: the account's default VPCs (Terraform's default_vpc_arns); with none, that case is not asked.
 */
export function simulatorCases(account, defaultVpcArns = []) {
  const region = ctx("aws:RequestedRegion", ["eu-west-2"]);
  const labTag = [ctx(`aws:RequestTag/${LAB_TAG}`, ["soa-01-x"]), ctx("aws:TagKeys", [LAB_TAG], "stringList")];
  const vpc = (r) => `arn:aws:ec2:${r}:${account}:vpc/*`;
  const role = `arn:aws:iam::${account}:role/cloudlabs-lab/lab-soa-01-x-vm`;
  const bounded = [ctx("iam:PermissionsBoundary", [`arn:aws:iam::${account}:policy/${AWS_BOUNDARY}`])];
  return [
    { name: "tagged VPC", action: "ec2:CreateVpc", resource: vpc("eu-west-2"), context: [region, ...labTag], want: "allowed" },
    { name: "bounded lab role", action: "iam:CreateRole", resource: role, context: bounded, want: "allowed" },
    { name: "untagged VPC", action: "ec2:CreateVpc", resource: vpc("eu-west-2"), context: [region], want: "denied" },
    { name: "the VPN server", action: "ec2:TerminateInstances", resource: `arn:aws:ec2:eu-west-2:${account}:instance/i-0123456789abcdef0`, context: [region, ctx("aws:ResourceTag/wg-admin", ["vpn"]), ctx(`aws:ResourceTag/${LAB_TAG}`, ["soa-01-x"])], want: "denied" },
    { name: "role without the boundary", action: "iam:CreateRole", resource: role, context: [], want: "denied" },
    { name: "role outside the path", action: "iam:CreateRole", resource: `arn:aws:iam::${account}:role/lab-soa-01-x-vm`, context: bounded, want: "denied" },
    { name: "access key", action: "iam:CreateAccessKey", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, context: [], want: "denied" },
    { name: "a third region", action: "ec2:CreateVpc", resource: vpc("us-east-2"), context: [ctx("aws:RequestedRegion", ["us-east-2"]), ...labTag], want: "denied" },
    ...fabricCases(account),
    { name: "the VPN server's user data", action: "ec2:DescribeInstanceAttribute", resource: `arn:aws:ec2:eu-west-2:${account}:instance/i-0123456789abcdef0`, context: [region, ctx("aws:ResourceTag/wg-admin", ["vpn"])], want: "denied" },
    { name: "pass the deploy role", action: "iam:PassRole", resource: `arn:aws:iam::${account}:role/wg-admin-deploy`, context: [ctx("iam:PassedToService", ["ec2.amazonaws.com"])], want: "denied" },
    { name: "AdministratorAccess on a lab role", action: "iam:AttachRolePolicy", resource: role, context: [...bounded, ctx("iam:PolicyARN", ["arn:aws:iam::aws:policy/AdministratorAccess"])], want: "denied" },
    { name: "change the boundary", action: "iam:CreatePolicyVersion", resource: `arn:aws:iam::${account}:policy/${AWS_BOUNDARY}`, context: [], want: "denied" },
    { name: "remove a boundary", action: "iam:DeleteRolePermissionsBoundary", resource: role, context: [], want: "denied" },
    blockPublicAccess(),
    { name: "EBS encryption by default", action: "ec2:EnableEbsEncryptionByDefault", resource: "*", context: [region], want: "denied" },
    // Final review, Important 1: a launch must tag its volumes (volume_tags), or the volume ARN is refused.
    { name: "a launch whose volume has no lab tag", action: "ec2:RunInstances", resource: `arn:aws:ec2:eu-west-2:${account}:volume/*`, context: [region], want: "denied" },
    // Ruling A54: an Instance Connect Endpoint makes its interface with the caller's credentials and no tags.
    { name: "EICE's network interface", action: "ec2:CreateNetworkInterface", resource: `arn:aws:ec2:eu-west-2:${account}:network-interface/*`, context: [region], want: "allowed" },
    // Ruling A55: SSM asks about AWS's document with no request tag.
    { name: "an SSM association", action: "ssm:CreateAssociation", resource: "arn:aws:ssm:eu-west-2::document/AWS-RunPatchBaseline", context: [region], want: "allowed" },
    // Ruling A56: a lab log group by its name (the tag read lags the create); any other still needs the tag.
    { name: "retention on a new lab log group", action: "logs:PutRetentionPolicy", resource: `arn:aws:logs:eu-west-2:${account}:log-group:/cloudlabs/soa-01-x/app`, context: [region], want: "allowed" },
    { name: "retention on another log group", action: "logs:PutRetentionPolicy", resource: `arn:aws:logs:eu-west-2:${account}:log-group:/aws/other`, context: [region], want: "denied" },
    ...ssmSettingCases(account),
    // Batch 2 (labs 06–10).
    { name: "a lab 07 user under the boundary", action: "iam:CreateUser", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, context: bounded, want: "allowed" },
    { name: "a user for another lab", action: "iam:CreateUser", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-06-cloudformation-ann`, context: bounded, want: "denied" },
    { name: "remove a hand-made key from the lab 07 user", action: "iam:DeleteAccessKey", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, context: [], want: "allowed" },
    { name: "delete the lab's analyzer", action: "access-analyzer:DeleteAnalyzer", resource: `arn:aws:access-analyzer:eu-west-2:${account}:analyzer/lab-soa-07-iam-kms-account`, context: [region, ctx(`aws:ResourceTag/${LAB_TAG}`, ["soa-07-iam-kms"])], want: "allowed" },
    { name: "an untagged CloudFormation stack", action: "cloudformation:CreateStack", resource: `arn:aws:cloudformation:eu-west-2:${account}:stack/lab-soa-06-x-stack/*`, context: [region], want: "denied" },
    { name: "a CloudFront distribution", action: "cloudfront:CreateDistribution", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"])], want: "allowed" },
    { name: "a Route 53 hosted zone", action: "route53:CreateHostedZone", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"])], want: "allowed" },
    { name: "an ECS cluster in us-east-1", action: "ecs:CreateCluster", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"]), ...labTag], want: "denied" },
    ...defaultVpcCase(account, defaultVpcArns),
  ];
}

/** Ruling A48's VPC network cases, the same for the role and the boundary: a lab-tagged ACL may change, untagged ones not. */
function fabricCases(account, prefix = "") {
  const region = ctx("aws:RequestedRegion", ["eu-west-2"]);
  const acl = `arn:aws:ec2:eu-west-2:${account}:network-acl/acl-0123456789abcdef0`;
  return [
    { name: `${prefix}an entry in a lab network ACL`, action: "ec2:CreateNetworkAclEntry", resource: acl, context: [region, ctx(`aws:ResourceTag/${LAB_TAG}`, ["soa-01-x"])], want: "allowed" },
    { name: `${prefix}tag an untagged network ACL`, action: "ec2:CreateTags", resource: acl, context: [region, ctx(`aws:RequestTag/${LAB_TAG}`, ["soa-01-x"]), ctx("aws:TagKeys", [LAB_TAG], "stringList")], want: "denied" },
    { name: `${prefix}an entry in an untagged network ACL`, action: "ec2:CreateNetworkAclEntry", resource: acl, context: [region], want: "denied" },
    { name: `${prefix}a rule in an untagged security group`, action: "ec2:AuthorizeSecurityGroupIngress", resource: `arn:aws:ec2:eu-west-2:${account}:security-group/sg-0123456789abcdef0`, context: [region], want: "denied" },
  ];
}
/** An account-wide EC2 setting (fix round 2): VPC Block Public Access would cut the VPN server off the internet. */
function blockPublicAccess(prefix = "") {
  return { name: `${prefix}block public access for the account`, action: "ec2:ModifyVpcBlockPublicAccessOptions", resource: "*", context: [ctx("aws:RequestedRegion", ["eu-west-2"])], want: "denied" };
}
/** Account-wide SSM settings (final review, Important 3): Default Host Management would put the VPN server under SSM. */
function ssmSettingCases(account, prefix = "") {
  const dhmc = `arn:aws:ssm:eu-west-2:${account}:servicesetting/ssm/managed-instance/default-ec2-instance-management-role`;
  const region = ctx("aws:RequestedRegion", ["eu-west-2"]);
  return [
    { name: `${prefix}SSM default host management`, action: "ssm:UpdateServiceSetting", resource: dhmc, context: [region], want: "denied" },
    { name: `${prefix}reset an SSM setting`, action: "ssm:ResetServiceSetting", resource: dhmc, context: [region], want: "denied" },
  ];
}
/** A subnet in the account's own default VPC (London's, else Ireland's). */
function defaultVpcCase(account, defaultVpcArns, prefix = "") {
  const arn = defaultVpcArns[0];
  if (!arn) return [];
  return [{ name: `${prefix}a subnet in the default VPC`, action: "ec2:CreateSubnet", resource: arn, context: [ctx("aws:RequestedRegion", [arn.split(":")[3]]), ctx(`aws:RequestTag/${LAB_TAG}`, ["soa-01-x"]), ctx("aws:TagKeys", [LAB_TAG], "stringList")], want: "denied" }];
}

/** The boundary's own cases (ruling A48), asked with `aws iam simulate-custom-policy` on the filled boundary document. */
export function boundaryCases(account, defaultVpcArns = []) {
  const p = "boundary: ";
  return [
    ...fabricCases(account, p),
    { name: `${p}delete every tag`, action: "ec2:DeleteTags", resource: `arn:aws:ec2:eu-west-2:${account}:vpc/vpc-0aaaaaaaaaaaaaaa1`, context: [ctx("aws:RequestedRegion", ["eu-west-2"]), ctx(`aws:ResourceTag/${LAB_TAG}`, ["soa-01-x"])], want: "denied" },
    blockPublicAccess(p),
    ...ssmSettingCases(account, p),
    // AWS Backup's role tags the snapshot it has just made (no lab tag yet, no create action): not refused (fix round 2).
    { name: `${p}tag a new snapshot`, action: "ec2:CreateTags", resource: `arn:aws:ec2:eu-west-2::snapshot/snap-0123456789abcdef0`, context: [ctx("aws:RequestedRegion", ["eu-west-2"]), ctx(`aws:RequestTag/${LAB_TAG}`, ["soa-04-x"]), ctx("aws:TagKeys", [LAB_TAG], "stringList")], want: "allowed" },
    ...defaultVpcCase(account, defaultVpcArns, p),
  ];
}

/** Every case AWS answered otherwise than wanted (allowed, or one of explicitDeny / implicitDeny), in words. */
export function simulatorProblems(results, cases) {
  const out = [];
  for (const c of cases) {
    const r = results.find((x) => x.name === c.name);
    if (!r) out.push(`${c.name}: AWS gave no answer`);
    else if ((r.decision === "allowed") !== (c.want === "allowed")) out.push(`${c.name}: wanted ${c.want}, AWS said ${r.decision}`);
  }
  return out;
}

/**
 * Ruling A23. "always": raised to `want` whenever below it (or unread); "if-below": only when read and below it.
 * The Instance Connect Endpoint quota's code is found by name at run time (`find`), then printed (V: write it here).
 */
export const LAB_QUOTAS = [
  { service: "vpc", code: "L-F678F1CE", name: "VPCs per Region", want: 20, raise: "always" },
  { service: "ec2", code: "L-0263D0A3", name: "EC2-VPC Elastic IPs", want: 10, raise: "always" },
  { service: "ec2", code: "L-1216C47A", name: "Running On-Demand Standard vCPUs", want: 32, raise: "if-below" },
  { service: "ec2", code: null, find: "Instance Connect", name: "Instance Connect Endpoints per Region", want: 10, raise: "if-below" },
  // Ruling P13: the role holds 10 managed policies after batch 2; 20 leaves room for a regenerated reference (V: the code,
  // and that IAM's quota is adjustable to 20).
  { service: "iam", code: "L-0DA4ABF3", name: "Managed policies per role", want: 20, raise: "if-below", regions: ["us-east-1"] },
];

/** The increases to ask for, from what each quota is now (value null: could not be read). */
export function quotaPlan(current, quotas = LAB_QUOTAS) {
  const out = [];
  for (const c of current) {
    const q = quotas.find((x) => x.service === c.service && x.code === c.code);
    if (!q || c.pending) continue;
    if (c.value === null ? q.raise === "always" : c.value < q.want) out.push({ service: c.service, code: c.code, region: c.region, to: q.want });
  }
  return out;
}

/**
 * Ruling A57: every service-linked role a lab may cause (SERVICE_LINKED), made ahead. AWS makes one at a service's first
 * use, and the service cannot use it for a minute or so: soa-03's first Auto Scaling group failed on it (release test,
 * 2026-10-15). One already there ("has been taken") is left alone; one AWS will not make ahead is only reported.
 */
export function serviceLinkedRoles(run, o) {
  const made = [];
  const notMade = [];
  for (const service of SERVICE_LINKED) {
    const r = run("aws", ["iam", "create-service-linked-role", "--aws-service-name", service, "--output", "json"]);
    if (r.status === 0) made.push(service);
    else if (!/has been taken|already exists/i.test(r.stderr ?? "")) notMade.push(`${service} (${errCode(r)})`);
  }
  o.log(made.length ? `Service-linked roles made ahead: ${made.join(", ")}` : "Service-linked roles: all there");
  if (notMade.length) o.log(`Service-linked roles AWS would not make ahead (it makes them at first use): ${notMade.join(", ")}`);
}

const errCode = (r) => /An error occurred \(([\w.]+)\)/.exec(r.stderr ?? "")?.[1] ?? `exit ${r.status}`;
const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

async function simulate(run, o, cases, source) {
  const results = [];
  for (const c of cases) {
    const args = ["iam", ...source, "--action-names", c.action, "--resource-arns", c.resource];
    if (c.context.length) args.push("--context-entries", JSON.stringify(c.context.map((e) => ({ ContextKeyName: e.key, ContextKeyValues: e.values, ContextKeyType: e.type }))));
    const r = run("aws", [...args, "--output", "json"]);
    const decision = r.status === 0 ? parse(r)?.EvaluationResults?.[0]?.EvalDecision : undefined;
    if (decision) results.push({ name: c.name, decision });
    o.log(`Simulator: ${c.name}: ${decision ?? `no answer (${errCode(r)})`} (wanted ${c.want})`);
  }
  return simulatorProblems(results, cases);
}

async function quotas(run, o) {
  const list = [];
  for (const q of LAB_QUOTAS) {
    let code = q.code;
    if (!code) {
      const r = run("aws", ["service-quotas", "list-service-quotas", "--service-code", q.service, "--region", AWS_LAB_REGIONS[0], "--query", `Quotas[?contains(QuotaName, '${q.find}')]`, "--output", "json"]);
      const found = r.status === 0 ? parse(r) : null;
      const rows = Array.isArray(found) ? found : found?.Quotas ?? [];
      const hit = rows.find((x) => /endpoint/i.test(x.QuotaName ?? "")) ?? rows[0];
      if (!hit?.QuotaCode) {
        o.log(`Quota ${q.name}: not found (${r.status === 0 ? "no quota by that name" : errCode(r)}); left alone`);
        continue;
      }
      code = hit.QuotaCode;
      o.log(`Quota ${q.name}: code ${code} ("${hit.QuotaName}")`);
    }
    list.push({ ...q, code });
  }
  const current = [];
  for (const q of list) {
    for (const region of q.regions ?? AWS_LAB_REGIONS) {
      const ask = (cmd) => run("aws", ["service-quotas", cmd, "--service-code", q.service, "--quota-code", q.code, "--region", region, "--output", "json"]);
      let r = ask("get-service-quota");
      if (r.status !== 0) r = ask("get-aws-default-service-quota");
      const v = r.status === 0 ? parse(r)?.Quota?.Value : undefined;
      const h = ask("list-requested-service-quota-change-history-by-quota");
      const pending = h.status === 0 && (parse(h)?.RequestedQuotas ?? []).some((x) => ["PENDING", "CASE_OPENED"].includes(x.Status));
      current.push({ service: q.service, code: q.code, region, value: typeof v === "number" ? v : null, pending });
    }
  }
  const plan = quotaPlan(current, list);
  for (const c of current) {
    const q = list.find((x) => x.code === c.code);
    const p = plan.find((x) => x.code === c.code && x.region === c.region);
    const now = c.value === null ? "could not be read" : String(c.value);
    if (p) {
      const r = run("aws", ["service-quotas", "request-service-quota-increase", "--service-code", c.service, "--quota-code", c.code, "--desired-value", String(p.to), "--region", c.region, "--output", "json"]);
      o.log(`Quota ${q.name} in ${c.region}: ${now}; ${r.status === 0 ? `asked for ${p.to}` : `could not ask for ${p.to} (${errCode(r)})`}`);
    } else {
      o.log(`Quota ${q.name} in ${c.region}: ${now}; ${c.pending ? "a request is already open" : c.value === null ? "left alone" : `target ${q.want} met`}`);
    }
  }
}

function costTag(run, o) {
  const r = run("aws", ["ce", "list-cost-allocation-tags", "--tag-keys", LAB_TAG, "--region", "us-east-1", "--output", "json"]);
  if (r.status !== 0) return o.log(`Cost tag ${LAB_TAG}: could not be read (${errCode(r)})`);
  const status = (parse(r)?.CostAllocationTags ?? []).find((t) => t.TagKey === LAB_TAG)?.Status;
  if (status === "Active") return o.log(`Cost tag ${LAB_TAG}: active`);
  if (status === "Inactive") {
    const u = run("aws", ["ce", "update-cost-allocation-tags-status", "--cost-allocation-tags-status", `TagKey=${LAB_TAG},Status=Active`, "--region", "us-east-1"]);
    return o.log(u.status === 0 ? `Cost tag ${LAB_TAG}: activated` : `Cost tag ${LAB_TAG}: could not be activated (${errCode(u)})`);
  }
  o.log(`Cost tag ${LAB_TAG}: not seen in billing yet: it appears about a day after the first tagged resource; run --labs again then`);
}

/**
 * The three steps; ok is false when a simulator answer is not A19's or A48's. o: { account, roleArn, defaultVpcArns
 * (Terraform's output), boundaryDoc (wg-admin-lab-boundary as applied: lab-policies.json's, filled), log }.
 */
export async function runLabsBootstrap(run, o) {
  const vpcs = o.defaultVpcArns ?? [];
  if (!vpcs.length) o.log("Simulator: the account has no default VPC, so that case is not asked");
  const role = simulatorCases(o.account, vpcs);
  const bound = boundaryCases(o.account, vpcs);
  const problems = [
    ...(await simulate(run, o, role, ["simulate-principal-policy", "--policy-source-arn", o.roleArn])),
    ...(await simulate(run, o, bound, ["simulate-custom-policy", "--policy-input-list", o.boundaryDoc])),
  ];
  if (problems.length) {
    o.log(`SIMULATOR: wg-admin-labs or its boundary does not behave as AWS labs spec §7.1, §7.2 and ruling A48 say (${problems.length}):`);
    for (const p of problems) o.log(`  ${p}`);
  } else o.log(`Simulator: all ${role.length + bound.length} answers as expected`);
  serviceLinkedRoles(run, o);
  await quotas(run, o);
  costTag(run, o);
  return { ok: problems.length === 0 };
}
