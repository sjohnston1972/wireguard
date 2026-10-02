// api/cost.ts
//
// Plain English: the Cost page's data. Azure's daily figures for the chosen
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
import { COST_RANGES, costWindow, projection, sessionsOf, type CostRange } from "../costview";
import type { CostResponse } from "../../../shared/api";

const money = (n: number) => `£${n.toFixed(2)}`;

export function registerCost(api: Hono<ApiEnv>): void {
  api.get("/cost", async (c) => {
    const range = (c.req.query("range") ?? "month") as CostRange;
    if (!COST_RANGES.includes(range)) return fail(c, 400, "bad_input", "The range must be month, 7d or 30d.", "range");
    const now = new Date();
    const win = costWindow(range, now);
    const monthStart = `${now.toISOString().slice(0, 7)}-01`;
    const [snap, cfg, runs, fetchedDay] = await Promise.all([getSnapshot(c.env), effectiveConfig(c.env), db.listRuns(c.env, 200), c.env.STATUS.get("cost:fetched_day")]);
    // One read covers the range, the stretch before it, and this month.
    const all = await db.costDays(c.env, win.prevFrom < monthStart ? win.prevFrom : monthStart);
    const budget = await budgetStatus(c.env, cfg, snap, now);

    const insights: string[] = [];
    const standby = snap.state === "standby" && snap.standby_since ? { since: snap.standby_since, perDayGbp: cfg.standbyRateGbp * 24 } : null;
    if (standby) insights.push(`Standby costs about ${money(standby.perDayGbp)} a day for the disk and address.`);
    if (budget.level === "warn" || budget.level === "over") {
      insights.push(`${money(budget.total)} of the ${money(budget.budget)} monthly budget is used (${Math.round(budget.pct)}%)${budget.level === "over" ? ", so Deploy asks for confirmation until the month ends" : ""}.`);
    }

    const running = snap.state === "running" && !!snap.running_since;
    const out: CostResponse = {
      now: now.toISOString(),
      range,
      meta: { currency: "GBP", timezone: "UTC", azureLagHours: 24, hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp, asOfDay: fetchedDay },
      session: { running, since: running ? snap.running_since : null, estimateGbp: running ? Math.max(0, ((now.getTime() - Date.parse(snap.running_since!)) / 3_600_000) * cfg.hourlyRateGbp) : null },
      standby,
      monthToDate: budget.actual,
      projection: projection(all, now),
      budget,
      daily: all.filter((d) => d.day >= win.from && d.day <= win.to),
      previous: all.filter((d) => d.day >= win.prevFrom && d.day <= win.prevTo),
      sessions: sessionsOf(runs, cfg, now),
      insights,
    };
    return c.json(out);
  });
}
