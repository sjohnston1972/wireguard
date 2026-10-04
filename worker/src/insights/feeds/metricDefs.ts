// insights/feeds/metricDefs.ts
//
// Plain English: which metric names Azure emits for the VM and for its
// public IP. The metric feeds ask only for these, because one name Azure
// does not know for a resource fails the whole call. Read daily, after each
// deploy (a new VM may emit a different set), and straight away when a
// metrics call is refused. Stored as az_latest['metricDefs']; the
// diagnostics route shows them, which is how the (V) metric names are
// confirmed live.

import type { FeedModule } from "../runner";
import type { FeedCtx, MetricDefsDoc } from "../types";
import { armRefusal, getLatest, paths, putLatest, str } from "../common";
import { METRICS_API } from "./metrics";

/** The names in a metricDefinitions reply (at most 200, each at most 100 characters); null when the reply has no list. */
export function normaliseMetricDefs(reply: unknown): string[] | null {
  const list = (reply as { value?: unknown })?.value;
  if (!Array.isArray(list)) return null;
  const names = list.slice(0, 200).map((d) => str((d as { name?: { value?: unknown } })?.name?.value, 100)).filter((n): n is string => n !== null);
  return [...new Set(names)];
}

async function readDefs(ctx: FeedCtx, path: string, what: string): Promise<string[] | null> {
  const r = await ctx.arm(`${path}/providers/Microsoft.Insights/metricDefinitions?api-version=${METRICS_API}`);
  if (r.status === 404) return null;
  if (!r.ok) throw await armRefusal(`the ${what} metric names`, r);
  return normaliseMetricDefs(await r.json());
}

export async function fetchMetricDefs(ctx: FeedCtx): Promise<MetricDefsDoc> {
  const p = paths(ctx.env, ctx.cfg);
  return { vm: await readDefs(ctx, p.vm, "VM"), pip: await readDefs(ctx, p.pip, "public IP") };
}

const metricDefs: FeedModule = {
  id: "metricDefs",
  title: "Metric names",
  cadenceMin: 1440,
  when: "vm",
  calls: 2,
  arm: true,
  async due(ctx, row) {
    if (!row || !row.next_due_at || Date.parse(row.next_due_at) <= ctx.now.getTime() + 30_000) return true;
    const have = await getLatest<MetricDefsDoc>(ctx.db, "metricDefs");
    if (!have || !have.doc?.vm) return true;
    // A new VM since they were read: read them again.
    const built = Date.parse(ctx.snap.running_since ?? "");
    return Number.isFinite(built) && Date.parse(have.updatedAt) < built;
  },
  async run(ctx) {
    const doc = await fetchMetricDefs(ctx);
    await putLatest(ctx.db, "metricDefs", doc, ctx.now.toISOString());
    return { status: "ok", error: null };
  },
};

export default metricDefs;
