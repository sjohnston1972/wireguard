// scripts/lib/aws-bootstrap-labs.mjs
//
// Plain English: the AWS labs' part of the one-off AWS setup (node
// scripts/aws-bootstrap.mjs --labs; AWS labs spec §7.1, §13, rulings A19 and
// A23), run after Terraform has made wg-admin-labs and its boundary:
//   1. asks IAM's policy simulator eight questions about wg-admin-labs (may it
//      make a tagged VPC and a bounded lab role; is it refused an untagged
//      VPC, the VPN server, a role without the boundary or off the path, an
//      access key and a third region) and fails loudly on any other answer
//   2. reads the four lab quotas in London and Ireland and asks for more where
//      they are below target (never twice: a pending request is left alone)
//   3. reports the cost allocation tag cloudlabs-lab, switching it on when
//      billing has seen it but it is off
// The aws command runner is passed in (the tests give a fake). Only names,
// numbers and AWS's error codes are printed: never an ARN or the account id.

import { AWS_LAB_REGIONS, LAB_TAG, AWS_BOUNDARY } from "./labs.mjs";

const ctx = (key, values, type = "string") => ({ key, type, values });

/** Ruling A19's cases, asked of the role with `aws iam simulate-principal-policy`. */
export function simulatorCases(account) {
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

const errCode = (r) => /An error occurred \(([\w.]+)\)/.exec(r.stderr ?? "")?.[1] ?? `exit ${r.status}`;
const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

async function simulate(run, o) {
  const cases = simulatorCases(o.account);
  const results = [];
  for (const c of cases) {
    const args = ["iam", "simulate-principal-policy", "--policy-source-arn", o.roleArn, "--action-names", c.action, "--resource-arns", c.resource];
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
    for (const region of AWS_LAB_REGIONS) {
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

/** The three steps; ok is false when the simulator's answers are not A19's. */
export async function runLabsBootstrap(run, o) {
  const problems = await simulate(run, o);
  if (problems.length) {
    o.log(`SIMULATOR: wg-admin-labs does not behave as AWS labs spec §7.1 says (${problems.length}):`);
    for (const p of problems) o.log(`  ${p}`);
  } else o.log("Simulator: all 8 answers as expected");
  await quotas(run, o);
  costTag(run, o);
  return { ok: problems.length === 0 };
}
