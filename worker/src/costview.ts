// costview.ts
//
// Plain English: the sums behind the Cost page. Which days a range covers
// (and the matching days before it, to compare against), what the month
// is heading for, and one row per past session with what it cost. Every
// function takes "now" so it can be tested on a fixed day. Days are UTC
// calendar days, the same as Azure's figures and the budget.

import type { CostDay, Run } from "./db";
import type { Config } from "./env";
import { sessionCost } from "./views/activity";

export type CostRange = "month" | "7d" | "30d";

export const COST_RANGES: CostRange[] = ["month", "7d", "30d"];

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The days a range covers, and the same-sized stretch before it, as
 * YYYY-MM-DD. "month" runs from the 1st to today, against the same days of
 * last month (stopping at that month's end if it is shorter). "7d" and "30d"
 * are the last 7 or 30 days including today, against the days just before.
 */
export function costWindow(range: CostRange, now: Date): { from: string; to: string; prevFrom: string; prevTo: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (range === "month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const prevStart = Date.UTC(y, m - 1, 1);
    const prevEnd = Date.UTC(y, m, 0); // last day of last month
    return { from: iso(Date.UTC(y, m, 1)), to: iso(today), prevFrom: iso(prevStart), prevTo: iso(Math.min(Date.UTC(y, m - 1, now.getUTCDate()), prevEnd)) };
  }
  const n = range === "7d" ? 7 : 30;
  const from = today - (n - 1) * DAY_MS;
  return { from: iso(from), to: iso(today), prevFrom: iso(from - n * DAY_MS), prevTo: iso(from - DAY_MS) };
}

/**
 * Where this month is heading: the month so far, divided by the days gone
 * (today's day of the month) and multiplied by the days in the month. Null
 * when Azure has not listed a day of this month yet: no data is not a £0
 * forecast.
 */
export function projection(days: CostDay[], now: Date): { gbp: number; basis: string } | null {
  const month = now.toISOString().slice(0, 7);
  const mine = days.filter((d) => d.day.startsWith(month));
  if (!mine.length) return null;
  const actual = mine.reduce((a, d) => a + d.gbp, 0);
  const elapsed = now.getUTCDate();
  const inMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    gbp: (actual / elapsed) * inMonth,
    basis: `£${actual.toFixed(2)} spent in the ${elapsed} ${elapsed === 1 ? "day" : "days"} so far this month, carried on at the same pace to all ${inMonth} days.`,
  };
}

/** One past session: a deploy and what came after it. */
export interface SessionRow {
  runId: string;
  started: string;
  ended: string | null;
  durationSeconds: number;
  region: string;
  vmSize: string;
  estimatedGbp: number;
  perHourGbp: number;
  stillRunning: boolean;
}

/**
 * One row per successful deploy, newest first. A session ends at the next
 * successful teardown, else it is still running. Region and size come from
 * what the deploy was asked for, falling back to today's settings. Only
 * those two fields are read from the run's payload; it is never returned.
 */
export function sessionsOf(runs: Run[], cfg: Config, now: Date): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const r of runs) {
    if (r.action !== "apply" || r.status !== "success" || !r.finished_at) continue;
    const start = Date.parse(r.finished_at);
    const end = runs
      .filter((x) => x.action === "destroy" && x.status === "success" && x.finished_at && Date.parse(x.finished_at) > start)
      .map((x) => x.finished_at!)
      .sort()[0] ?? null;
    let region = cfg.region;
    let vmSize = cfg.vmSize;
    try {
      const p = JSON.parse(r.payload_json ?? "{}") as { region?: unknown; vm_size?: unknown };
      if (typeof p.region === "string" && p.region) region = p.region;
      if (typeof p.vm_size === "string" && p.vm_size) vmSize = p.vm_size;
    } catch {
      /* keep the defaults */
    }
    rows.push({
      runId: r.id,
      started: r.finished_at,
      ended: end,
      durationSeconds: Math.max(0, Math.round(((end ? Date.parse(end) : now.getTime()) - start) / 1000)),
      region,
      vmSize,
      estimatedGbp: sessionCost(r, runs, cfg, now.getTime()) ?? 0,
      perHourGbp: cfg.hourlyRateGbp,
      stillRunning: end === null,
    });
  }
  return rows.sort((a, b) => b.started.localeCompare(a.started));
}
