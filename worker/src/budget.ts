// budget.ts
//
// Plain English: the monthly budget (Settings > Monthly budget warning).
//   - How much of it is used: this month's actual spend from Azure, plus
//     what the VM running now will cost by the time its timer ends.
//   - The watchman checks that every 5 minutes and pings the phone once at
//     80% and once at 100%, per calendar month. What was sent is remembered
//     in KV, so it does not repeat every 5 minutes.
//   - At or over 100%, Deploy asks "are you sure?" with a tick box. The
//     Worker checks the box itself, so a deploy cannot slip past the question.
// A budget of £0 means "no budget": nothing is checked, nothing is sent.
//
// Months are UTC calendar months, the same as the Cost page and Azure's
// month-to-date figures.

import type { Env, Config } from "./env";
import * as db from "./db";
import type { Snapshot } from "./state";
import { getSnapshot } from "./state";
import { effectiveConfig } from "./settings";
import { RunError } from "./runs";
import { notify } from "./notify";
import { dashboardButton } from "./actions";

export type BudgetLevel = "none" | "ok" | "warn" | "over";

export interface BudgetStatus {
  /** The budget in £; 0 means none is set. */
  budget: number;
  /** Actual spend this month, from Azure (the Cost page's daily figures). */
  actual: number;
  /** Estimate for the VM running now, up to its timer, not yet in Azure's figures. */
  session: number;
  /** actual + session. */
  total: number;
  /** total as a percentage of the budget (0 when there is no budget). */
  pct: number;
  level: BudgetLevel;
  /** "2026-09" */
  month: string;
  /** The highest alert already sent this month: 0 (none), 80 or 100. */
  alerted: 0 | 80 | 100;
}

/** The name of the Deploy form's "deploy anyway" tick box. */
export const OVER_BUDGET_FIELD = "over_budget_ok";

const alertKey = (month: string) => `budget:alerted:${month}`;

/**
 * The sum, pure so it can be tested. The session estimate starts where
 * Azure's figures stop (midnight after the last day Azure has listed), so
 * the same hours are not counted twice, and it runs to the auto-destroy
 * timer, or to now if there is no timer. Both ends stay inside this month.
 */
export function budgetFigures(o: { budget: number; days: { day: string; gbp: number }[]; snap: Pick<Snapshot, "state" | "running_since" | "auto_destroy_at">; hourlyRate: number; now: Date }): Omit<BudgetStatus, "alerted"> {
  const month = o.now.toISOString().slice(0, 7);
  const monthStart = Date.parse(`${month}-01T00:00:00Z`);
  const next = new Date(monthStart);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthEnd = next.getTime();
  const days = o.days.filter((d) => d.day.startsWith(month));
  const actual = days.reduce((a, d) => a + d.gbp, 0);

  let session = 0;
  if (o.snap.state === "running" && o.snap.running_since) {
    const lastDay = days.map((d) => d.day).sort().at(-1);
    const azureUpTo = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000 : monthStart;
    const from = Math.max(Date.parse(o.snap.running_since), azureUpTo, monthStart);
    const deadline = o.snap.auto_destroy_at ? Date.parse(o.snap.auto_destroy_at) : NaN;
    const to = Math.min(Number.isFinite(deadline) ? Math.max(deadline, o.now.getTime()) : o.now.getTime(), monthEnd);
    if (Number.isFinite(from) && to > from) session = ((to - from) / 3_600_000) * o.hourlyRate;
  }

  const total = actual + session;
  if (!(o.budget > 0)) return { budget: 0, actual, session, total, pct: 0, level: "none", month };
  const pct = (total / o.budget) * 100;
  return { budget: o.budget, actual, session, total, pct, level: pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok", month };
}

/** Where the budget stands right now. */
export async function budgetStatus(env: Env, cfg?: Config, snap?: Snapshot, now = new Date()): Promise<BudgetStatus> {
  const month = now.toISOString().slice(0, 7);
  const [c, s, days, sent] = await Promise.all([cfg ?? effectiveConfig(env), snap ?? getSnapshot(env), db.costDays(env, `${month}-01`), env.STATUS.get(alertKey(month))]);
  const f = budgetFigures({ budget: c.monthlyBudgetGbp, days, snap: s, hourlyRate: c.hourlyRateGbp, now });
  return { ...f, alerted: sent === "100" ? 100 : sent === "80" ? 80 : 0 };
}

const money = (n: number) => `£${n.toFixed(2)}`;

/**
 * The watchman's check. Sends the 80% alert, or the 100% one, if it has not
 * been sent yet this month. Jumping straight past 100% sends only the 100%
 * one. Returns a note for the watchman's log, or null.
 */
export async function checkBudget(env: Env, cfg: Config, now = new Date()): Promise<string | null> {
  const b = await budgetStatus(env, cfg, undefined, now);
  if (b.level === "none") return null;
  const due: 0 | 80 | 100 = b.level === "over" ? 100 : b.level === "warn" ? 80 : 0;
  if (!due || due <= b.alerted) return null;
  // Remember first, so a slow or failing notification cannot cause a repeat.
  await env.STATUS.put(alertKey(b.month), String(due), { expirationTtl: 40 * 86400 });
  const sums = `${money(b.actual)} spent in Azure so far${b.session > 0 ? ` plus about ${money(b.session)} for the VM running now, to its timer` : ""}: ${Math.round(b.pct)}% of the ${money(b.budget)} monthly budget.`;
  const msg = due === 100 ? `Monthly budget reached. ${sums} Deploy will ask you to confirm until the month ends.` : `80% of the monthly budget used. ${sums}`;
  await db.addAlert(env, "budget", msg);
  await notify(env, due === 100 ? "wg-admin: over budget" : "wg-admin: 80% of budget", msg, { priority: due === 100 ? 4 : 3, tags: ["moneybag"], buttons: [dashboardButton(env)] });
  return `budget: ${due}% alert sent`;
}

/**
 * Deploy's guard. At or over budget, a deploy needs the tick box; without it
 * this throws with a message for the screen. Under budget, or with no
 * budget, it does nothing.
 */
export async function requireBudgetOk(env: Env, confirmed: boolean): Promise<void> {
  if (confirmed) return;
  const b = await budgetStatus(env);
  if (b.level !== "over") return;
  throw new RunError(`This month is at ${Math.round(b.pct)}% of the ${money(b.budget)} budget. Tick "Deploy anyway" to go ahead.`);
}
