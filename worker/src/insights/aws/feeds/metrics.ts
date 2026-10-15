// insights/aws/feeds/metrics.ts
//
// Plain English: the headend's AWS/EC2 metrics from CloudWatch. One
// GetMetricData call every 15 minutes while the server runs (and for 15
// minutes after it stops) asks for every metric in AWS_METRICS
// (shared/azureMetrics.ts) over the last 45 minutes in 5-minute periods.
// CloudWatch bills per metric asked for, not per point, so one call per 15
// minutes gives the same 5-minute graph as one per 5 at a third of the cost,
// and the overlap fills in points CloudWatch publishes late.
//
// The answer becomes one wide row per 5-minute slot in hist_aws_vm, with
// hist_az_vm's column names where the meaning matches. Each point is placed
// by its own timestamp, so the order CloudWatch sends them in (it may send
// newest first) and how many it sends do not matter. A slot not yet over is
// dropped (its sums are only part of the slot's). Sums of bytes and of
// operations become per second over the slot (Sum / 300); packet and credit
// sums are kept as they are. A point CloudWatch leaves out is null, never 0,
// and never wipes a value already stored.
// Spec 2026-10-15-aws-insights-design.md, section 4.1.

import { AWS_METRICS, AWS_VM_COLUMNS, type AwsVmColumn } from "../../../../../shared/azureMetrics";
import { MIN, SLOT, num, slotOf } from "../../common";
import type { AwsFeed, AwsFeedCtx } from "../types";

/** CloudWatch's Query API version. */
export const CLOUDWATCH_VERSION = "2010-08-01";
/** How far back each call reaches: nine 5-minute slots. */
export const AWS_METRICS_WINDOW_MS = 45 * MIN;

export type AwsMetricRow = { t: string } & Record<AwsVmColumn, number | null>;

/** GetMetricData's parameters: one query per catalogue entry (its Id is the column it fills), the headend's InstanceId, 5-minute periods. */
export function awsMetricsParams(instanceId: string, now: Date): Record<string, string> {
  const p: Record<string, string> = {
    StartTime: slotOf(now.getTime() - AWS_METRICS_WINDOW_MS),
    EndTime: now.toISOString(),
    ScanBy: "TimestampAscending",
  };
  AWS_METRICS.forEach((m, i) => {
    const k = `MetricDataQueries.member.${i + 1}`;
    p[`${k}.Id`] = m.column;
    p[`${k}.MetricStat.Metric.Namespace`] = "AWS/EC2";
    p[`${k}.MetricStat.Metric.MetricName`] = m.name;
    p[`${k}.MetricStat.Metric.Dimensions.member.1.Name`] = "InstanceId";
    p[`${k}.MetricStat.Metric.Dimensions.member.1.Value`] = instanceId;
    p[`${k}.MetricStat.Period`] = String(SLOT);
    p[`${k}.MetricStat.Stat`] = m.stat;
  });
  return p;
}

/** One GetMetricData call for the headend. The XML. */
export async function fetchAwsMetrics(ctx: AwsFeedCtx, instanceId: string): Promise<string> {
  return ctx.query("monitoring", "GetMetricData", awsMetricsParams(instanceId, ctx.now), CLOUDWATCH_VERSION);
}

/**
 * The top-level <member>…</member> elements of `xml`, as strings; a
 * member's own nested members (its Timestamps and Values) stay inside it.
 */
function members(xml: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of xml.matchAll(/<(\/?)member(\/?)>/g)) {
    const at = m.index ?? 0;
    if (m[2]) continue; // <member/>: empty
    if (!m[1]) {
      if (depth++ === 0) start = at;
    } else if (depth > 0 && --depth === 0) {
      out.push(xml.slice(start, at + m[0].length));
    }
  }
  return out;
}

/** The texts of the <member>s directly inside the first <tag>…</tag> of `xml` (none for <tag/> or no tag). */
function listOf(xml: string, tag: string): string[] {
  const block = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/<member>([^<]*)<\/member>/g)].map((m) => m[1]!.trim());
}

/** The catalogue entry each query Id (= column) stands for. */
const BY_COLUMN = new Map(AWS_METRICS.map((m) => [m.column as string, m]));

/** GetMetricData's answer as rows, one per slot that is over, oldest first. */
export function normaliseAwsMetrics(xml: string, now: Date): AwsMetricRow[] {
  const results = xml.match(/<MetricDataResults>([\s\S]*)<\/MetricDataResults>/)?.[1];
  if (results === undefined) return [];
  const slots = new Map<string, AwsMetricRow>();
  for (const r of members(results).slice(0, 40)) {
    // The result's own Id: cut the Timestamps and Values lists out first.
    const own = r.replace(/<(Timestamps|Values|Messages)>[\s\S]*?<\/\1>/g, "");
    const id = own.match(/<Id>([^<]*)<\/Id>/)?.[1]?.trim() ?? "";
    const metric = BY_COLUMN.get(id);
    if (!metric) continue;
    const times = listOf(r, "Timestamps");
    const values = listOf(r, "Values");
    for (let i = 0; i < Math.min(times.length, values.length, 200); i++) {
      const ts = Date.parse(times[i]!);
      if (!Number.isFinite(ts)) continue;
      const t = slotOf(ts);
      let row = slots.get(t);
      if (!row) {
        row = { t, ...Object.fromEntries(AWS_VM_COLUMNS.map((c) => [c, null])) } as AwsMetricRow;
        slots.set(t, row);
      }
      const v = num(values[i]);
      if (v === null) continue;
      row[metric.column] = metric.stat === "Sum" && (metric.unit === "bytes/s" || metric.unit === "ops/s") ? v / SLOT : v;
    }
  }
  const from = Date.parse(slotOf(now.getTime() - AWS_METRICS_WINDOW_MS));
  return [...slots.values()]
    .filter((r) => Date.parse(r.t) >= from && Date.parse(r.t) + SLOT * 1000 <= now.getTime())
    .sort((a, b) => a.t.localeCompare(b.t));
}

/** Upsert rows; a null never overwrites a stored value. Integer binds are CAST (D1 binds numbers as REAL). */
export async function storeAwsMetrics(db: D1Database, rows: AwsMetricRow[]): Promise<void> {
  if (!rows.length) return;
  const cols = AWS_VM_COLUMNS;
  const sql = `INSERT INTO hist_aws_vm (res, t, ${cols.join(", ")}) VALUES (CAST(?1 AS INTEGER), ?2, ${cols.map((_, i) => `?${i + 3}`).join(", ")})
    ON CONFLICT (res, t) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(", ")}`;
  await db.batch(rows.map((r) => db.prepare(sql).bind(SLOT, r.t, ...cols.map((c) => r[c] ?? null))));
}

const metrics: AwsFeed = {
  id: "aws.metrics",
  title: "CloudWatch metrics",
  cadenceMin: 15,
  when: "running",
  calls: 2, // the headend lookup and GetMetricData
  async run(ctx) {
    const h = await ctx.headend();
    if (!h) return { status: "ok", error: null }; // no headend: nothing to measure
    await storeAwsMetrics(ctx.db, normaliseAwsMetrics(await fetchAwsMetrics(ctx, h.id), ctx.now));
    return { status: "ok", error: null };
  },
};

export default metrics;
