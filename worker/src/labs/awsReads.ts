// labs/awsReads.ts
//
// Plain English: every AWS read the lab engine makes (AWS labs spec §6), in
// one place: the resources tagged cloudlabs-lab in a region, the IAM names
// under /cloudlabs-lab/, the Config recorders and lab dashboards of a
// region, the account id, whether the wg-admin-labs role and the
// wg-admin-lab-boundary policy exist, whether the cloudlabs-lab cost tag is
// active, Cost Explorer's daily cost grouped by that tag, and whether EC2
// instances or VPC endpoints the tagging API lists still exist. Each takes one
// call from the Net first (AWS's signed client fetches by itself, so the
// call is counted before it is made) and then asks once, one page; AWS's
// refusals come back as AwsError. Nothing here writes to AWS.

import type { Env } from "../env";
import { AwsError, awsJson, awsQuery, ec2, filters, xmlAll, xmlFirst, xmlItems, xmlOwn, xmlOwnItems } from "../cloud/awsApi";
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
  // Ruling P2: API Gateway's resource is a path, /apis/<id>[/stages/<name>]: the last collection named is the type.
  if (service === "apigateway" && resource.startsWith("/")) {
    const seg = resource.slice(1).split("/");
    if (seg[0] === "apis" && seg[2] === "stages" && seg[3]) return { service, type: "stages", id: `${seg[1]}/${seg.slice(3).join("/")}` };
    return { service, type: seg[0] ?? "", id: seg.slice(1).join("/") };
  }
  // Ruling P22: a WAF ACL's scope and kind are its type (global/webacl, regional/webacl); a Lattice listener is a
  // listener, not its service.
  if (service === "wafv2") {
    const seg = resource.split("/");
    return { service, type: seg.slice(0, 2).join("/"), id: seg.slice(2).join("/") };
  }
  if (service === "vpc-lattice" && /^service\/[^/]+\/listener\//.test(resource)) return { service, type: "listener", id: resource.slice("service/".length) };
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

/** The EC2 kinds the orphan sweep can confirm: the Describe call, the filter that names ids, and the states that mean gone. */
const EC2_CONFIRM = {
  instance: { action: "DescribeInstances", filter: "instance-id", gone: ["terminated", "shutting-down"] },
  "vpc-endpoint": { action: "DescribeVpcEndpoints", filter: "vpc-endpoint-id", gone: ["deleted"] },
} as const;
export type Ec2ConfirmKind = keyof typeof EC2_CONFIRM;
/** EC2 takes at most 200 values in one filter; ids past that are left unconfirmed (still counted). */
export const EC2_CONFIRM_MAX = 200;

/**
 * Of `ids` (EC2 instances or VPC endpoints in `region`), the ones EC2 says are really gone: not listed at all, or
 * listed as terminated / shutting-down (an instance) or deleted (an endpoint). One call, filtered by id (so an id
 * EC2 no longer knows is simply absent rather than failing the whole call). When EC2 says there is another page,
 * only the ids it listed as gone count: an absent id might be on the next page. Any refusal throws (AwsError), so
 * the caller keeps those items counted.
 */
export async function ec2Gone(env: Env, net: Net, region: string, kind: Ec2ConfirmKind, ids: string[]): Promise<Set<string>> {
  const c = EC2_CONFIRM[kind];
  const asked = [...new Set(ids)].slice(0, EC2_CONFIRM_MAX);
  if (!asked.length) return new Set();
  net.take(1);
  let xml: string;
  try {
    xml = await ec2(env, c.action, filters([[c.filter, asked]]), region);
  } catch (e) {
    // A NotFound names no one id among many, so it can only clear an id that was asked alone.
    if (asked.length === 1 && e instanceof AwsError && /\.NotFound$/.test(e.code)) return new Set(asked);
    throw e;
  }
  const states = new Map<string, string>();
  if (kind === "instance") {
    for (const r of xmlItems(xml, "reservationSet"))
      for (const i of xmlOwnItems(r, "instancesSet")) {
        const own = xmlOwn(i);
        const id = xmlFirst(own, "instanceId");
        const state = xmlFirst(own.match(/<instanceState>[\s\S]*?<\/instanceState>/)?.[0] ?? "", "name");
        if (id) states.set(id, (state ?? "").toLowerCase());
      }
  } else {
    for (const it of xmlItems(xml, "vpcEndpointSet")) {
      const own = xmlOwn(it);
      const id = xmlFirst(own, "vpcEndpointId");
      if (id) states.set(id, (xmlFirst(own, "state") ?? "").toLowerCase());
    }
  }
  const more = !!xmlFirst(xml, "nextToken");
  const gone: readonly string[] = c.gone;
  return new Set(asked.filter((id) => (states.has(id) ? gone.includes(states.get(id)!) : !more)));
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
