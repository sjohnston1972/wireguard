// insights/feeds/metrics.ts
//
// Plain English: what the two metric feeds (vmMetrics, pipMetrics) share.
// One Azure Monitor call per resource asks for the last 20 minutes in
// 5-minute slots, every aggregation at once; the answer becomes one wide row
// per slot (a column per metric and aggregation, shared/azureMetrics.ts),
// and the last three complete slots are upserted, so a value Azure sends
// late fills in on the next run. Byte totals become bytes per second over
// the slot. A value Azure leaves out is null, never 0, and never wipes one
// already stored. Nor is a 0 Azure sends where it had nothing to measure:
// the VM's slots from before it booted or after it was gone are dropped
// (vmBounds), and a 0 for free memory is no data (ZERO_IS_NO_DATA).
//
// Azure refuses the whole call (400) when one metric name is unknown for
// the resource, so only the names the metricDefs feed saw are asked for; a
// 400 makes metricDefs due again straight away.

import type { FeedCtx, MetricDefsDoc } from "../types";
import type { Snapshot } from "../../state";
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

/** The metrics call's query string for `names` at `now`. Spaces go as %20 (never "+"), each name encoded, commas between. */
export function metricsQuery(names: string[], now: Date): string {
  const to = Date.parse(slotOf(now.getTime()));
  const from = to - WINDOW_MS;
  return [
    `api-version=${METRICS_API}`,
    `metricnames=${names.map(encodeURIComponent).join(",")}`,
    "interval=PT5M",
    `timespan=${encodeURIComponent(`${slotOf(from)}/${slotOf(to)}`)}`,
    "aggregation=Average,Maximum,Minimum,Total",
  ].join("&");
}

/**
 * Metrics whose 0 is never a reading. Available Memory Bytes: Linux's
 * MemAvailable is never 0 bytes on a VM that is still reporting, but the
 * guest's first sample during boot is 0, and a Minimum aggregation turns it
 * into "0 bytes free" for the whole slot. The Minimum is kept (it is the
 * slot's worst moment, which the Average would blur) and a 0 is no data.
 */
const ZERO_IS_NO_DATA = new Set(["Available Memory Bytes"]);

/** When the VM was there to measure (ms): slots starting before `from` or after `to` are not data. */
export interface MetricBounds {
  from: number | null;
  to: number | null;
}

/**
 * When the VM existed, from the snapshot. From: its boot (the latest
 * heartbeat's time less its uptime), else running_since; Azure answers 0
 * for some metrics (CPU credits) at times before the VM existed, and a slot
 * that began before the boot is only partly the VM's. To: once the VM is no
 * longer running (tear-down, Standby), its last heartbeat; a running VM has
 * no end, so Azure's figures still show while its heartbeat is late.
 */
export function vmBounds(snap: Pick<Snapshot, "state" | "agent" | "running_since" | "last_agent_at">): MetricBounds {
  const at = Date.parse(snap.agent?.at ?? "");
  const up = snap.agent?.uptime_seconds;
  const boot = Number.isFinite(at) && typeof up === "number" && up > 0 ? at - up * 1000 : Date.parse(snap.running_since ?? "");
  const last = Date.parse(snap.last_agent_at ?? "");
  return { from: Number.isFinite(boot) ? boot : null, to: snap.state !== "running" && Number.isFinite(last) ? last : null };
}

/** The metrics reply as rows, the last three complete slots inside `bounds`, oldest first. */
export function normaliseMetrics(resource: MetricResource, reply: unknown, now: Date, bounds: MetricBounds = { from: null, to: null }): MetricRow[] {
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
        if (v === null || (v === 0 && ZERO_IS_NO_DATA.has(name))) continue;
        row[w.column] =w.aggregation === "Total" && w.unit === "bytes/s" ? v / SLOT : v;
      }
    }
  }
  const complete = [...slots.values()].filter((r) => Date.parse(r.t) + SLOT * 1000 <= now.getTime()).sort((a, b) => a.t.localeCompare(b.t));
  const inside = (r: MetricRow) => (bounds.from === null || Date.parse(r.t) >= bounds.from) && (bounds.to === null || Date.parse(r.t) <= bounds.to);
  return complete.slice(-KEEP_SLOTS).filter(inside);
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
  const r = await ctx.arm(`${path}/providers/Microsoft.Insights/metrics?${metricsQuery(names, ctx.now)}`);
  if (r.status === 400) {
    await markDue(ctx, "metricDefs");
    throw new Error("Azure refused a metric name for this resource (400); the metric names are being read again.");
  }
  if (r.status === 404) return; // the resource is already gone (a tear-down under way): nothing to store
  if (!r.ok) throw await armRefusal(`the ${resource === "vm" ? "VM" : "public IP"} metrics`, r);
  // The VM's slots from before it booted (or after it was gone) are Azure's zeros, not readings.
  await storeMetrics(ctx.db, resource, normaliseMetrics(resource, await r.json(), ctx.now, resource === "vm" ? vmBounds(ctx.snap) : undefined));
}
