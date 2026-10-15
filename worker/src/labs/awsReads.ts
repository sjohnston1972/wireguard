// labs/awsReads.ts
//
// Plain English: every AWS read the lab engine makes (AWS labs spec §6), in
// one place: the resources tagged cloudlabs-lab in a region, the IAM names
// under /cloudlabs-lab/, the Config recorders and lab dashboards of a
// region, the account id, whether the wg-admin-labs role and the
// wg-admin-lab-boundary policy exist, whether the cloudlabs-lab cost tag is
// active, and Cost Explorer's daily cost grouped by that tag. Each takes one
// call from the Net first (AWS's signed client fetches by itself, so the
// call is counted before it is made) and then asks once, one page; AWS's
// refusals come back as AwsError. Nothing here writes to AWS.

import type { Env } from "../env";
import { AwsError, awsJson, awsQuery, xmlAll, xmlFirst } from "../cloud/awsApi";
import { AWS_IAM_PATH, LAB_TAG } from "../../../shared/labs";
import type { Net } from "./net";

/** A resource the tagging API lists: its ARN and its tags. */
export interface TaggedArn {
  arn: string;
  tags: Record<string, string>;
}

/** An ARN's service, resource type and id: arn:aws:ec2:eu-west-2:1234:instance/i-0a is ec2, instance, i-0a; S3's bucket ARN has no type ("bucket"). */
export function arnParts(arn: string): { service: string; type: string; id: string } {
  const parts = arn.split(":");
  const service = parts[2] ?? "";
  const resource = parts.slice(5).join(":");
  const m = resource.match(/^([^/:]+)[/:](.+)$/);
  if (m) return { service, type: m[1]!, id: m[2]! };
  return { service, type: service === "s3" ? "bucket" : "", id: resource };
}

/** How the sweep names a tagged item: "<service>:<type> <resource id>" (ec2:instance i-0abc). */
export function taggedName(arn: string): string {
  const p = arnParts(arn);
  return `${p.type ? `${p.service}:${p.type}` : p.service} ${p.id}`;
}

/** IAM and STS are global: one host each, signed for us-east-1. */
const IAM = { region: "us-east-1", host: "iam.amazonaws.com" } as const;
const STS = { region: "us-east-1", host: "sts.amazonaws.com" } as const;
const IAM_VERSION = "2010-05-08";
const CE = { service: "ce", region: "us-east-1", host: "ce.us-east-1.amazonaws.com" } as const;

/** One page of tagged resources; `truncated` when AWS said there is more (a PaginationToken) than the page holds. */
export type TaggedPage = TaggedArn[] & { truncated: boolean };

/**
 * Everything tagged cloudlabs-lab in `region` (only `labId`'s when given): one page of at most 100. The list says
 * `truncated` when AWS has more than that page, so a caller never takes it for the whole picture.
 */
export async function labTagged(env: Env, net: Net, region: string, labId?: string): Promise<TaggedPage> {
  net.take(1);
  const r = await awsJson<{ ResourceTagMappingList?: { ResourceARN?: string; Tags?: { Key?: string; Value?: string }[] }[]; PaginationToken?: string }>(env, {
    service: "tagging",
    region,
    host: `tagging.${region}.amazonaws.com`,
    target: "ResourceGroupsTaggingAPI_20170126.GetResources",
    body: { TagFilters: [{ Key: LAB_TAG, ...(labId ? { Values: [labId] } : {}) }], ResourcesPerPage: 100 },
  });
  const list = (r.ResourceTagMappingList ?? [])
    .filter((m) => typeof m.ResourceARN === "string")
    .map((m) => ({ arn: m.ResourceARN!, tags: Object.fromEntries((m.Tags ?? []).filter((t) => typeof t.Key === "string").map((t) => [t.Key!, String(t.Value ?? "")])) }));
  return Object.assign(list, { truncated: !!r.PaginationToken });
}

const IAM_LISTS = {
  roles: { action: "ListRoles", field: "RoleName", extra: {} },
  "instance-profiles": { action: "ListInstanceProfiles", field: "InstanceProfileName", extra: {} },
  policies: { action: "ListPolicies", field: "PolicyName", extra: { Scope: "Local" } },
  users: { action: "ListUsers", field: "UserName", extra: {} },
} as const;

/** The names of IAM roles, instance profiles, customer policies or users at path /cloudlabs-lab/ (one page of up to 1000). */
export async function iamLabNames(env: Env, net: Net, what: "roles" | "instance-profiles" | "policies" | "users"): Promise<string[]> {
  const l = IAM_LISTS[what];
  net.take(1);
  const xml = await awsQuery(env, "iam", l.action, { PathPrefix: AWS_IAM_PATH, MaxItems: "1000", ...l.extra }, IAM_VERSION, IAM);
  // An instance profile lists its roles inside it (with RoleName): only the profile's own name field is read.
  return xmlAll(xml, l.field);
}

/** The names of the AWS Config recorders in `region` (an account has at most one per region). */
export async function configRecorderNames(env: Env, net: Net, region: string): Promise<string[]> {
  net.take(1);
  const r = await awsJson<{ ConfigurationRecorders?: { name?: string }[] }>(env, {
    service: "config",
    region,
    host: `config.${region}.amazonaws.com`,
    target: "StarlingDoveService.DescribeConfigurationRecorders",
    body: {},
  });
  return (r.ConfigurationRecorders ?? []).map((x) => x.name).filter((n): n is string => typeof n === "string");
}

/** The names of the CloudWatch dashboards named lab-* in `region` (one page). */
export async function dashboardNames(env: Env, net: Net, region: string): Promise<string[]> {
  net.take(1);
  const xml = await awsQuery(env, "monitoring", "ListDashboards", { DashboardNamePrefix: "lab-" }, "2010-08-01", { region });
  return xmlAll(xml, "DashboardName");
}

/** The account the Worker's AWS user belongs to (STS GetCallerIdentity, which needs no permission). */
export async function awsAccountId(env: Env, net: Net): Promise<string> {
  net.take(1);
  const xml = await awsQuery(env, "sts", "GetCallerIdentity", {}, "2011-06-15", STS);
  const id = xmlFirst(xml, "Account");
  if (!id || !/^\d{12}$/.test(id)) throw new Error("AWS did not say which account the Worker's AWS user is in.");
  return id;
}

const noSuchEntity = (e: unknown) => e instanceof AwsError && e.code === "NoSuchEntity";

/** Does the IAM role exist? False when IAM says NoSuchEntity; any other refusal throws. */
export async function iamRoleExists(env: Env, net: Net, name: string): Promise<boolean> {
  net.take(1);
  try {
    await awsQuery(env, "iam", "GetRole", { RoleName: name }, IAM_VERSION, IAM);
    return true;
  } catch (e) {
    if (noSuchEntity(e)) return false;
    throw e;
  }
}

/** Does the IAM policy exist? False when IAM says NoSuchEntity; any other refusal throws. */
export async function iamPolicyExists(env: Env, net: Net, arn: string): Promise<boolean> {
  net.take(1);
  try {
    await awsQuery(env, "iam", "GetPolicy", { PolicyArn: arn }, IAM_VERSION, IAM);
    return true;
  } catch (e) {
    if (noSuchEntity(e)) return false;
    throw e;
  }
}

/** Is the user-defined cost allocation tag `key` Active, Inactive, or not known to Cost Explorer yet (null)? */
export async function costTagStatus(env: Env, net: Net, key: string): Promise<"Active" | "Inactive" | null> {
  net.take(1);
  const r = await awsJson<{ CostAllocationTags?: { TagKey?: string; Status?: string }[] }>(env, {
    ...CE,
    target: "AWSInsightsIndexService.ListCostAllocationTags",
    body: { TagKeys: [key], Type: "UserDefined" },
  });
  const s = (r.CostAllocationTags ?? []).find((t) => t.TagKey === key)?.Status;
  return s === "Active" || s === "Inactive" ? s : null;
}

/**
 * Cost Explorer's daily unblended cost from `start` up to `end` (exclusive), grouped by the cloudlabs-lab tag: one
 * row per day and tag value ("" for untagged spend), in USD. One page (a month of daily groups fits).
 */
export async function costByLabTag(env: Env, net: Net, start: string, end: string): Promise<{ day: string; lab: string; usd: number }[]> {
  net.take(1);
  const r = await awsJson<{ ResultsByTime?: { TimePeriod?: { Start?: string }; Groups?: { Keys?: string[]; Metrics?: { UnblendedCost?: { Amount?: string } } }[] }[] }>(env, {
    ...CE,
    target: "AWSInsightsIndexService.GetCostAndUsage",
    body: { TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "TAG", Key: LAB_TAG }] },
  });
  const out: { day: string; lab: string; usd: number }[] = [];
  for (const t of r.ResultsByTime ?? []) {
    const day = t.TimePeriod?.Start;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const g of t.Groups ?? []) {
      const key = g.Keys?.[0] ?? "";
      // Cost Explorer names a tag group "<key>$<value>"; "<key>$" is spend with no such tag.
      if (!key.startsWith(`${LAB_TAG}$`)) continue;
      out.push({ day, lab: key.slice(LAB_TAG.length + 1), usd: Number(g.Metrics?.UnblendedCost?.Amount ?? 0) || 0 });
    }
  }
  return out;
}
