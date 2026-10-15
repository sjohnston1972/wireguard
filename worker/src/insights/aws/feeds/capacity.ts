// insights/aws/feeds/capacity.ts
//
// Plain English: can the next AWS deploy get its instance type? Whether the
// region offers it (DescribeInstanceTypeOfferings), its vCPUs
// (DescribeInstanceTypes), the On-Demand Standard vCPU quota (Service Quotas)
// and what is running (DescribeInstances), stored in aws_capacity as a
// CapacityDoc; and awsCapacityCheck, which turns that into the deploy form's
// warning (OverviewResponse.awsCapacity).
// Spec 2026-10-15-aws-insights-design.md, section 4.5.
//
// Read daily for the AWS region and, for AWS labs, Ireland (eu-west-1, the
// labs' only secondary region), 4 calls each (AWS labs spec §6 Capacity), and
// the sizes cloudlabs deploys there: the configured instance type, the test
// VM's t4g.nano and every AWS lab's instance_types from the catalogue. "Used" counts the vCPUs (cores ×
// threads) of every pending or running On-Demand instance in the Standard
// families (A, C, D, H, I, M, R, T, Z), which is what quota L-1216C47A
// limits; spot instances and other families (GPU, Inferentia, ...) have
// quotas of their own. A deploy needs the size's vCPUs, plus the test VM's
// when it is on. Warnings only when the answer is no; the data can be a day
// old, so the deploy form says "may" and offers "Deploy anyway", as on Azure.

import type { CapacityCheck } from "../../../../../shared/api";
import { awsRegionName } from "../../../../../shared/azureMetrics";
import type { Config } from "../../../env";
import { filters, xmlFirst, xmlItems, xmlOwn } from "../../../cloud/awsApi";
import { num } from "../../common";
import { emptyCheck } from "../../feeds/capacity";
import type { CapacityDoc } from "../../types";
import type { AwsFeed, AwsFeedCtx } from "../types";
import { catalogue } from "../../../labs/catalogue";
import { AWS_LAB_REGIONS } from "../../../../../shared/labs";

/** The test VM's instance type on AWS (spec 4.5). */
export const AWS_TEST_VM_SIZE = "t4g.nano";
/** Service Quotas: EC2's "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances", in vCPUs. */
export const AWS_STANDARD_QUOTA = "L-1216C47A";
/** CapacityDoc's family for every AWS size: the one Standard quota. */
export const AWS_STANDARD_FAMILY = "standard";
/** CapacityCheck.family.name on AWS (spec 4.5). */
export const AWS_FAMILY_NAME = "Standard (T family)";
/** Instance types the Standard quota counts: a family letter of A, C, D, H, I, M, R, T or Z, then the generation digit. */
const STANDARD_TYPE = /^[acdhimrtz]\d/i;

type SizeInfo = CapacityDoc["sizes"][number];

/** The instance types worth recording: the configured one and the test VM's, each once. */
export function awsCapacitySizes(cfg: Config): string[] {
  return [...new Set([cfg.aws.instanceType, AWS_TEST_VM_SIZE])];
}

/** The four replies one reading is made of; `types` is null when no size was offered (nothing to ask). */
export interface AwsCapacityReplies {
  offerings: string;
  types: string | null;
  quota: unknown;
  instances: string;
}

/** The instance types DescribeInstanceTypeOfferings lists as offered in the region. */
export function offeredTypes(xml: string): string[] {
  return xmlItems(xml, "instanceTypeOfferingSet").flatMap((i) => xmlFirst(xmlOwn(i), "instanceType") ?? []);
}

/** Each instance type's default vCPUs, from DescribeInstanceTypes. */
export function instanceTypeVcpus(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of xmlItems(xml, "instanceTypeSet")) {
    const own = xmlOwn(item);
    const name = xmlFirst(own, "instanceType");
    const vcpus = num(xmlFirst(own, "defaultVCpus"));
    if (name && vcpus !== null && vcpus > 0) out.set(name, vcpus);
  }
  return out;
}

/** The quota's value (whole vCPUs), or null when the answer has none. */
export function quotaLimit(reply: unknown): number | null {
  const v = num((reply as { Quota?: { Value?: unknown } })?.Quota?.Value);
  return v === null || v < 0 ? null : Math.floor(v);
}

/** vCPUs (cores × threads per core) of the pending and running On-Demand Standard instances in DescribeInstances' answer. */
export function runningStandardVcpus(xml: string): number {
  let used = 0;
  for (const reservation of xmlItems(xml, "reservationSet")) {
    for (const instance of xmlItems(reservation, "instancesSet")) {
      const own = xmlOwn(instance);
      const state = own.match(/<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/)?.[1];
      if (state !== "pending" && state !== "running") continue;
      if (xmlFirst(own, "instanceLifecycle") === "spot") continue; // spot has its own quota
      if (!STANDARD_TYPE.test(xmlFirst(own, "instanceType") ?? "")) continue;
      const cores = num(xmlFirst(own, "coreCount")) ?? 0;
      const threads = num(xmlFirst(own, "threadsPerCore")) ?? 1;
      if (cores > 0) used += cores * (threads > 0 ? threads : 1);
    }
  }
  return used;
}

/** The replies as a CapacityDoc: each size's availability and vCPUs; the quota as the "standard" usage and the region's cores. */
export function normaliseAwsCapacity(r: AwsCapacityReplies, sizes: string[]): CapacityDoc {
  const offered = new Set(offeredTypes(r.offerings));
  const vcpus = r.types ? instanceTypeVcpus(r.types) : new Map<string, number>();
  const found: SizeInfo[] = sizes.map((name) =>
    offered.has(name) ? { name, available: true, reason: null, vcpus: vcpus.get(name) ?? null, family: AWS_STANDARD_FAMILY } : { name, available: false, reason: "NotOffered", vcpus: null, family: AWS_STANDARD_FAMILY },
  );
  const limit = quotaLimit(r.quota);
  if (limit === null) return { sizes: found, usages: [], cores: null };
  const used = runningStandardVcpus(r.instances);
  return { sizes: found, usages: [{ family: AWS_STANDARD_FAMILY, used, limit }], cores: { used, limit } };
}

/** Read one region (ctx.region unless given): 4 calls, 3 when none of the sizes is offered (DescribeInstanceTypes refuses unknown types). */
export async function fetchAwsCapacity(ctx: AwsFeedCtx, sizes: string[], region: string = ctx.region): Promise<AwsCapacityReplies> {
  const offerings = await ctx.ec2("DescribeInstanceTypeOfferings", { LocationType: "region", ...filters([["instance-type", sizes]]) }, region);
  const offered = sizes.filter((s) => offeredTypes(offerings).includes(s));
  const types = offered.length ? await ctx.ec2("DescribeInstanceTypes", Object.fromEntries(offered.map((s, i) => [`InstanceType.${i + 1}`, s])), region) : null;
  const quota = await ctx.json<unknown>({
    service: "servicequotas",
    region,
    host: `servicequotas.${region}.amazonaws.com`,
    target: "ServiceQuotasV20190624.GetServiceQuota",
    body: { ServiceCode: "ec2", QuotaCode: AWS_STANDARD_QUOTA },
  });
  const instances = await ctx.ec2("DescribeInstances", filters([["instance-state-name", ["pending", "running"]]]), region);
  return { offerings, types, quota, instances };
}

/** The instance types the feed records: the server's (awsCapacitySizes), then every AWS lab's in the catalogue, each once. */
export function awsLabCapacitySizes(cfg: Config): string[] {
  return [...new Set([...awsCapacitySizes(cfg), ...catalogue().labs.filter((l) => l.cloud === "aws").flatMap((l) => l.capacity.instance_types ?? [])])];
}

/** The regions the feed reads: AWS's configured one (the server's and the lab sessions'), then the labs' secondary region. */
export function awsCapacityRegions(region: string): string[] {
  return [...new Set([region, ...AWS_LAB_REGIONS])];
}

export async function storeAwsCapacity(db: D1Database, region: string, doc: CapacityDoc, at: string): Promise<void> {
  await db.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT (region) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at").bind(region, JSON.stringify(doc), at).run();
}

/** The region's stored reading, or null. */
export async function readAwsCapacity(db: D1Database, region: string): Promise<{ doc: CapacityDoc; fetchedAt: string } | null> {
  const r = await db.prepare("SELECT json, fetched_at FROM aws_capacity WHERE region = ?1").bind(region).first<{ json: string; fetched_at: string }>();
  if (!r) return null;
  try {
    return { doc: JSON.parse(r.json) as CapacityDoc, fetchedAt: r.fetched_at };
  } catch {
    return null;
  }
}

/**
 * The capacity check for `size` in `region` from the stored doc (null = not
 * read yet): vCPUs needed = the size's, plus the test VM's (t4g.nano) when
 * `needTestVm`; family.name "Standard (T family)". The wording follows
 * Azure's capacityCheck; there is no "checked … ago" tail (no clock here),
 * the response carries fetchedAt.
 */
export function awsCapacityCheck(doc: CapacityDoc | null, region: string, size: string, needTestVm: boolean, fetchedAt: string | null): CapacityCheck {
  const s = doc?.sizes.find((x) => x.name === size);
  if (!doc || !s) return emptyCheck(region, size);
  const place = awsRegionName(region);
  const test = needTestVm ? doc.sizes.find((x) => x.name === AWS_TEST_VM_SIZE) ?? null : null;
  const out: CapacityCheck = { ...emptyCheck(region, size), available: s.available, reason: s.reason, fetchedAt, total: doc.cores };
  if (!s.available) {
    out.ok = false;
    out.message = `${size} isn't offered in ${place}.`;
    return out;
  }
  if (test && !test.available) {
    out.ok = false;
    out.message = `The test VM's ${AWS_TEST_VM_SIZE} isn't offered in ${place}.`;
    return out;
  }
  if (s.vcpus === null) return out; // offered; quota not judged
  // t4g.nano has 2 vCPUs; an older doc without it still counts them.
  const need = s.vcpus + (needTestVm ? test?.vcpus ?? 2 : 0);
  out.vcpusNeeded = need;
  const q = doc.usages.find((u) => u.family === AWS_STANDARD_FAMILY) ?? null;
  if (!q) return out; // quota unreadable: not judged
  out.family = { name: AWS_FAMILY_NAME, used: q.used, limit: q.limit };
  if (q.used + need > q.limit) {
    out.ok = false;
    out.message = `Needs ${need} On-Demand Standard vCPUs; ${q.used} of ${q.limit} used in ${place}.`;
  } else {
    out.ok = true;
    out.message = `Available · vCPU quota ${q.used} of ${q.limit} used`;
  }
  return out;
}

const capacity: AwsFeed = {
  id: "aws.capacity",
  title: "Capacity and quota",
  cadenceMin: 1440,
  when: "always",
  calls: 8,
  async run(ctx) {
    const sizes = awsLabCapacitySizes(ctx.cfg);
    // One reading per region, each stored as soon as it is read: a refusal in the second keeps the first.
    for (const region of awsCapacityRegions(ctx.region)) {
      const doc = normaliseAwsCapacity(await fetchAwsCapacity(ctx, sizes, region), sizes);
      await storeAwsCapacity(ctx.db, region, doc, ctx.now.toISOString());
    }
    return { status: "ok", error: null };
  },
};

export default capacity;
