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
import { regionName } from "./region";
import type { CostBreakdown } from "../../shared/api";

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
 * Where this month is heading: the month so far, divided by the days up to
 * the last one Azure has reported (its figures lag a day, so not today) and multiplied by the days in the month. Null
 * when Azure has not listed a day of this month yet: no data is not a £0
 * forecast.
 */
export function projection(days: CostDay[], now: Date): { gbp: number; basis: string } | null {
  const month = now.toISOString().slice(0, 7);
  const mine = days.filter((d) => d.day.startsWith(month));
  if (!mine.length) return null;
  const actual = mine.reduce((a, d) => a + d.gbp, 0);
  const elapsed = Math.max(...mine.map((d) => Number(d.day.slice(8, 10))));
  const inMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    gbp: (actual / elapsed) * inMonth,
    basis: `£${actual.toFixed(2)} over the ${elapsed} ${elapsed === 1 ? "day" : "days"} Azure has reported so far this month, carried on at the same pace to all ${inMonth} days.`,
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

/**
 * Which of the four groups the Cost page shows an Azure service name belongs
 * to: Virtual Machines is compute; Bandwidth, Virtual Network, IP addresses
 * and Load Balancer (anything with "network" in it too) are network; Storage
 * and Managed Disks are disk; everything else is other.
 */
export function costType(category: string): "compute" | "network" | "disk" | "other" {
  const c = category.toLowerCase();
  if (c.includes("virtual machines")) return "compute";
  if (/bandwidth|network|ip address|load balancer/.test(c)) return "network";
  if (/storage|disk/.test(c)) return "disk";
  return "other";
}

/** Group amounts, drop the empty ones, biggest first, each with its share (one decimal) of what is left. */
function shares<K extends string>(amounts: Map<K, number>): { key: K; gbp: number; pct: number }[] {
  const live = [...amounts].filter(([, g]) => g > 0);
  const total = live.reduce((a, [, g]) => a + g, 0);
  return live.sort((a, b) => b[1] - a[1]).map(([key, g]) => ({ key, gbp: Math.round(g * 1e6) / 1e6, pct: Math.round((g / total) * 1000) / 10 }));
}

/**
 * Azure's split for a range as the page shows it: by type and by region,
 * each with its share. `rows` are the stored rows added up over the range.
 * Null when there are no rows at all. Slices with nothing in them are left out.
 */
export function breakdownOf(rows: { category: string; location: string; gbp: number }[], asOfDay: string | null): CostBreakdown | null {
  if (!rows.length) return null;
  const types = new Map<"compute" | "network" | "disk" | "other", number>();
  const places = new Map<string, number>();
  for (const r of rows) {
    const t = costType(r.category);
    types.set(t, (types.get(t) ?? 0) + r.gbp);
    places.set(r.location, (places.get(r.location) ?? 0) + r.gbp);
  }
  return {
    byType: shares(types).map((s) => ({ type: s.key, gbp: s.gbp, pct: s.pct })),
    byRegion: shares(places).map((s) => ({ location: s.key, name: s.key ? regionName(s.key) : "Unassigned", gbp: s.gbp, pct: s.pct })),
    basis: "azure",
    asOfDay,
  };
}

/**
 * The fallback when Azure has no split for the range: what the sessions that
 * started in it are estimated to have cost, by region. No types (an estimate
 * knows only the hourly rate). Null when no session started in the range.
 */
export function estimateBreakdown(sessions: SessionRow[], from: string, to: string): CostBreakdown | null {
  const places = new Map<string, number>();
  for (const s of sessions) {
    const d = s.started.slice(0, 10);
    if (d < from || d > to) continue;
    places.set(s.region, (places.get(s.region) ?? 0) + s.estimatedGbp);
  }
  const byRegion = shares(places).map((s) => ({ location: s.key, name: regionName(s.key), gbp: s.gbp, pct: s.pct }));
  if (!byRegion.length) return null;
  return { byType: [], byRegion, basis: "estimate", asOfDay: null };
}
