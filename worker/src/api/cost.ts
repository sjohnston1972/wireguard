// api/cost.ts
//
// Plain English: the Cost page's data. Azure's and AWS's daily figures for the chosen
// range (and the stretch before it, to compare), the month against the
// budget, where the month is heading, what the VM running now has cost so
// far, and one row per past session. The insights are plain facts the data
// backs up, nothing more.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { budgetStatus } from "../budget";
import { ratesFor } from "../env";
import { cloudOf } from "../state";
import { COST_RANGES, breakdownOf, costWindow, estimateBreakdown, projection, sessionsOf, type CostRange } from "../costview";
import { labCostRows } from "../labs/summary";
import type { CostResponse } from "../../../shared/api";

const money = (n: number) => `£${n.toFixed(2)}`;

export function registerCost(api: Hono<ApiEnv>): void {
  api.get("/cost", async (c) => {
    const range = (c.req.query("range") ?? "month") as CostRange;
    if (!COST_RANGES.includes(range)) return fail(c, 400, "bad_input", "The range must be month, 7d or 30d.", "range");
    const now = new Date();
    const win = costWindow(range, now);
    const monthStart = `${now.toISOString().slice(0, 7)}-01`;
    const [snap, cfg, runs, azureFetched, awsFetched] = await Promise.all([getSnapshot(c.env), effectiveConfig(c.env), db.listRuns(c.env, 200), c.env.STATUS.get("cost:fetched_day"), c.env.STATUS.get("cost:aws_fetched_day")]);
    // As of the older of the clouds' last pulls: the figures are only complete that far. One cloud alone: its own.
    const asOfDay = [azureFetched, awsFetched].filter((d): d is string => !!d).sort()[0] ?? null;
    // One read covers the range, the stretch before it, and this month.
    const since = win.prevFrom < monthStart ? win.prevFrom : monthStart;
    const azureDays = await db.costDays(c.env, since);
    const awsDays = await db.awsCostDays(c.env, since);
    // One figure per day: Azure's plus AWS's (both in pounds).
    const byDay = new Map<string, db.CostDay>();
    for (const d of [...azureDays, ...awsDays]) {
      const have = byDay.get(d.day);
      byDay.set(d.day, have ? { day: d.day, gbp: have.gbp + d.gbp, fetched_at: have.fetched_at > d.fetched_at ? have.fetched_at : d.fetched_at } : { day: d.day, gbp: d.gbp, fetched_at: d.fetched_at });
    }
    const all = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    const monthOf = (rows: { day: string; gbp: number }[]) => rows.filter((d) => d.day >= monthStart).reduce((a, d) => a + d.gbp, 0);
    const rates = ratesFor(cfg, cloudOf(snap));
    const budget = await budgetStatus(c.env, cfg, snap, now);
    const split = await db.costBreakdownRange(c.env, win.from, win.to);
    const sessions = sessionsOf(runs, cfg, now);

    const insights: string[] = [];
    const standby = snap.state === "standby" && snap.standby_since ? { since: snap.standby_since, perDayGbp: rates.standbyRateGbp * 24 } : null;
    if (standby) insights.push(`Standby costs about ${money(standby.perDayGbp)} a day for the disk and address.`);
    if (budget.level === "warn" || budget.level === "over") {
      insights.push(`${money(budget.total)} of the ${money(budget.budget)} monthly budget is used (${Math.round(budget.pct)}%)${budget.level === "over" ? ", so Deploy asks for confirmation until the month ends" : ""}.`);
    }
    // Under 80%: where the month is heading against the budget (the projection's own figure).
    // Its basis names the clouds that reported a day this month.
    const reported = [...(azureDays.some((d) => d.day >= monthStart) ? ["Azure"] : []), ...(awsDays.some((d) => d.day >= monthStart) ? ["AWS"] : [])];
    const proj = projection(all, now, reported);
    if (budget.level === "ok" && proj) insights.push(`At this pace the month ends at about ${money(proj.gbp)}, ${Math.round((proj.gbp / budget.budget) * 100)}% of the ${money(budget.budget)} monthly budget.`);
    // This month's sessions (each estimated at the hourly rate, as the Sessions table shows them).
    const mine = sessions.filter((s) => s.started.startsWith(monthStart.slice(0, 7)));
    if (mine.length) {
      const avg = mine.reduce((a, s) => a + s.estimatedGbp, 0) / mine.length;
      insights.push(`${mine.length} ${mine.length === 1 ? "session" : "sessions"} this month, about ${money(avg)} each.`);
    }

    const running = snap.state === "running" && !!snap.running_since;
    const out: CostResponse = {
      now: now.toISOString(),
      range,
      // azureLagHours keeps its name (the app reads it); AWS's Cost Explorer lags about the same day.
      meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: rates.hourlyRateGbp, standbyRateGbp: rates.standbyRateGbp, asOfDay, azureAsOfDay: azureFetched || null, awsAsOfDay: awsFetched || null },
      session: { running, since: running ? snap.running_since : null, estimateGbp: running ? Math.max(0, ((now.getTime() - Date.parse(snap.running_since!)) / 3_600_000) * rates.hourlyRateGbp) : null },
      standby,
      // The budget's actual already holds Azure (labs included) and AWS.
      monthToDate: budget.actual,
      byCloud: { azure: budget.actual - monthOf(awsDays), aws: monthOf(awsDays) },
      projection: proj,
      budget,
      daily: all.filter((d) => d.day >= win.from && d.day <= win.to),
      previous: all.filter((d) => d.day >= win.prevFrom && d.day <= win.prevTo),
      sessions,
      insights,
      // Azure's split when it has one for the range; else the sessions' estimate; else nothing.
      breakdown: split.length ? breakdownOf(split, split.reduce((a, r) => (r.last_day > a ? r.last_day : a), "")) : estimateBreakdown(sessions, win.from, win.to),
      // This month per lab (labs/summary.ts), whatever the range; [] with none.
      labs: await labCostRows(c.env, now),
    };
    return c.json(out);
  });
}
