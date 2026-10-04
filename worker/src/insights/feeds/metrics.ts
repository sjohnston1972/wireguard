// insights/feeds/metrics.ts
//
// Plain English: what the two metric feeds (vmMetrics, pipMetrics) share.
// One Azure Monitor call per resource asks for the last 20 minutes in
// 5-minute slots, every aggregation at once; the answer becomes one wide row
// per slot (a column per metric and aggregation, shared/azureMetrics.ts),
// and the last three complete slots are upserted, so a value Azure sends
// late fills in on the next run. Byte totals become bytes per second over
// the slot. A value Azure leaves out is null, never 0, and never wipes one
// already stored.
//
// Azure refuses the whole call (400) when one metric name is unknown for
// the resource, so only the names the metricDefs feed saw are asked for; a
// 400 makes metricDefs due again straight away.

import type { FeedCtx, MetricDefsDoc } from "../types";
import { AZURE_METRICS, PIP_COLUMNS, VM_COLUMNS, azureMetricNames } from "../../../../shared/azureMetrics";
import { SLOT, armRefusal, getLatest, markDue, num, slotOf } from "../common";

export const METRICS_API = "2023-10-01";
/** How far back each call reaches: four slots, of which the last three complete ones are kept. */
const WINDOW_MS = 20 * 60_000;
const KEEP_SLOTS = 3;

export type MetricResource = "vm" | "pip";
export type MetricRow = { t: string } & Record<string, number | null | string>;

const COLUMNS: Record<MetricResource, readonly string[]> = { vm: VM_COLUMNS, pip: PIP_COLUMNS };
const TABLE: Record<MetricResource, string> = { vm: "hist_az_vm", pip: "hist_az_pip" };

/** The names to ask for: the catalogue's, less any the resource does not emit (when metricDefs has read them). */
export function namesToAsk(resource: MetricResource, emitted: string[] | null): string[] {
  const all = azureMetricNames(resource);
  if (!emitted) return all;
  const have = new Set(emitted);
  return all.filter((n) => have.has(n));
}

/** The metrics call's query for `names` at `now`. */
export function metricsQuery(names: string[], _emitted: string[] | null, now: Date): URLSearchParams {
  const to = Date.parse(slotOf(now.getTime()));
  const from = to - WINDOW_MS;
  return new URLSearchParams({
    "api-version": METRICS_API,
    metricnames: names.join(","),
    interval: "PT5M",
    timespan: `${slotOf(from)}/${slotOf(to)}`,
    aggregation: "Average,Maximum,Minimum,Total",
  });
}

/** The metrics reply as rows, the last three complete slots, oldest first. */
export function normaliseMetrics(resource: MetricResource, reply: unknown, now: Date): MetricRow[] {
  const values = (reply as { value?: unknown })?.value;
  if (!Array.isArray(values)) return [];
  const cols = COLUMNS[resource];
  const slots = new Map<string, MetricRow>();
  for (const m of values.slice(0, 40)) {
    const name = (m as { name?: { value?: unknown } })?.name?.value;
    if (typeof name !== "string") continue;
    const wanted = AZURE_METRICS.filter((x) => x.resource === resource && x.name === name);
    if (!wanted.length) continue;
    const series = (m as { timeseries?: unknown }).timeseries;
    const data = Array.isArray(series) ? (series[0] as { data?: unknown })?.data : null;
    if (!Array.isArray(data)) continue;
    for (const d of data.slice(0, 50)) {
      const ts = Date.parse(String((d as { timeStamp?: unknown })?.timeStamp ?? ""));
      if (!Number.isFinite(ts)) continue;
      const t = slotOf(ts);
      let row = slots.get(t);
      if (!row) {
        row = { t, ...Object.fromEntries(cols.map((c) => [c, null])) } as MetricRow;
        slots.set(t, row);
      }
      for (const w of wanted) {
        const v = num((d as Record<string, unknown>)[w.aggregation.toLowerCase()]);
        if (v === null) continue;
        row[w.column] = w.aggregation === "Total" && w.unit === "bytes/s" ? v / SLOT : v;
      }
    }
  }
  const complete = [...slots.values()].filter((r) => Date.parse(r.t) + SLOT * 1000 <= now.getTime()).sort((a, b) => a.t.localeCompare(b.t));
  return complete.slice(-KEEP_SLOTS);
}

/** Upsert rows; a null never overwrites a stored value. Integer binds are CAST (D1 binds numbers as REAL). */
export async function storeMetrics(db: D1Database, resource: MetricResource, rows: MetricRow[]): Promise<void> {
  if (!rows.length) return;
  const cols = COLUMNS[resource];
  const sql = `INSERT INTO ${TABLE[resource]} (res, t, ${cols.join(", ")}) VALUES (CAST(?1 AS INTEGER), ?2, ${cols.map((_, i) => `?${i + 3}`).join(", ")})
    ON CONFLICT (res, t) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(", ")}`;
  await db.batch(rows.map((r) => db.prepare(sql).bind(SLOT, r.t, ...cols.map((c) => r[c] ?? null))));
}

/** Fetch, normalise and store one resource's metrics. */
export async function runMetrics(ctx: FeedCtx, resource: MetricResource, path: string): Promise<void> {
  const defs = await getLatest<MetricDefsDoc>(ctx.db, "metricDefs");
  const emitted = defs?.doc?.[resource] ?? null;
  const names = namesToAsk(resource, Array.isArray(emitted) ? emitted : null);
  if (!names.length) return; // the resource emits none of ours
  const r = await ctx.arm(`${path}/providers/Microsoft.Insights/metrics?${metricsQuery(names, emitted, ctx.now)}`);
  if (r.status === 400) {
    await markDue(ctx.db, "metricDefs");
    throw new Error("Azure refused a metric name for this resource (400); the metric names are being read again.");
  }
  if (!r.ok) throw await armRefusal(`the ${resource === "vm" ? "VM" : "public IP"} metrics`, r);
  await storeMetrics(ctx.db, resource, normaliseMetrics(resource, await r.json(), ctx.now));
}
