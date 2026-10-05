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

/** A live lab session as the budget counts it (labs spec §9.3). */
export interface BudgetLab {
  state: string;
  requested_at: string;
  auto_destroy_at: string | null;
  max_until: string;
  est_gbp_h: number;
  /** The hours chosen at deploy (from the deploy or test run's payload); null when not known. */
  hours?: number | null;
}

/**
 * The sum, pure so it can be tested. The session estimate starts where
 * Azure's figures stop (midnight after the last day Azure has listed), so
 * the same hours are not counted twice, and it runs to the auto-destroy
 * timer, or to now if there is no timer. Both ends stay inside this month.
 *
 * Labs (spec §9.3): `labDays` is Azure's daily spend on the rg-lab-* groups
 * (lab_cost_days), added to the actual; each live lab in `labs` adds its
 * est_gbp_h from when it started (or from where Azure's figures stop) to
 * its timer. Before it has one (still deploying) it counts for the hours
 * chosen at deploy, never past max_until; to max_until only when those
 * hours are not known.
 */
export function budgetFigures(o: { budget: number; days: { day: string; gbp: number }[]; snap: Pick<Snapshot, "state" | "running_since" | "auto_destroy_at">; hourlyRate: number; now: Date; labs?: BudgetLab[]; labDays?: { day: string; gbp: number }[] }): Omit<BudgetStatus, "alerted"> {
  const month = o.now.toISOString().slice(0, 7);
  const monthStart = Date.parse(`${month}-01T00:00:00Z`);
  const next = new Date(monthStart);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthEnd = next.getTime();
  const days = o.days.filter((d) => d.day.startsWith(month));
  const labDays = (o.labDays ?? []).filter((d) => d.day.startsWith(month));
  const actual = days.reduce((a, d) => a + d.gbp, 0) + labDays.reduce((a, d) => a + d.gbp, 0);

  let session = 0;
  if (o.snap.state === "running" && o.snap.running_since) {
    const lastDay = days.map((d) => d.day).sort().at(-1);
    const azureUpTo = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000 : monthStart;
    const from = Math.max(Date.parse(o.snap.running_since), azureUpTo, monthStart);
    const deadline = o.snap.auto_destroy_at ? Date.parse(o.snap.auto_destroy_at) : NaN;
    const to = Math.min(Number.isFinite(deadline) ? Math.max(deadline, o.now.getTime()) : o.now.getTime(), monthEnd);
    if (Number.isFinite(from) && to > from) session = ((to - from) / 3_600_000) * o.hourlyRate;
  }
  session += labsEstimate(o.labs ?? [], labDays, o.now, monthStart, monthEnd);

  const total = actual + session;
  if (!(o.budget > 0)) return { budget: 0, actual, session, total, pct: 0, level: "none", month };
  const pct = (total / o.budget) * 100;
  return { budget: o.budget, actual, session, total, pct, level: pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok", month };
}

/**
 * Where a live lab's estimate stops: its timer; before it has one, the hours
 * chosen at deploy from when it was requested (never past max_until); with
 * neither, max_until.
 */
function labEnd(l: BudgetLab): number {
  if (l.auto_destroy_at) return Date.parse(l.auto_destroy_at);
  const max = Date.parse(l.max_until);
  const hours = Number(l.hours);
  if (l.hours != null && Number.isFinite(hours) && hours > 0) {
    const chosen = Date.parse(l.requested_at) + hours * 3_600_000;
    return Number.isFinite(max) ? Math.min(chosen, max) : chosen;
  }
  return max;
}

/** The live labs' estimate to their timers (or chosen hours, or max_until), from where Azure's lab figures stop, inside this month. */
export function labsEstimate(labs: BudgetLab[], labDays: { day: string; gbp: number }[], now: Date, monthStart: number, monthEnd: number): number {
  const lastDay = labDays.map((d) => d.day).sort().at(-1);
  const azureUpTo = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000 : monthStart;
  let sum = 0;
  for (const l of labs) {
    const from = Math.max(Date.parse(l.requested_at), azureUpTo, monthStart);
    const end = labEnd(l);
    const to = Math.min(Number.isFinite(end) ? Math.max(end, now.getTime()) : now.getTime(), monthEnd);
    if (Number.isFinite(from) && to > from && l.est_gbp_h > 0) sum += ((to - from) / 3_600_000) * l.est_gbp_h;
  }
  return sum;
}

/**
 * The labs' part of the month: live sessions and Azure's lab days. A lab
 * problem (a missing table, a bad row) must never stop the gateway's budget
 * check, so this answers nothing rather than throwing.
 */
export async function budgetLabs(env: Env, month: string): Promise<{ labs: BudgetLab[]; labDays: { day: string; gbp: number }[] }> {
  try {
    const [labs, labDays] = await Promise.all([
      // The hours chosen at deploy are kept in the session's deploy (or test) run's payload (labs/engine.ts deployLab).
      env.DB.prepare(
        `SELECT s.state, s.requested_at, s.auto_destroy_at, s.max_until, s.est_gbp_h,
                (SELECT json_extract(r.payload_json, '$.hours') FROM lab_runs r
                  WHERE r.session_id = s.id AND r.action IN ('deploy', 'test') AND json_valid(r.payload_json)
                  ORDER BY r.requested_at ASC LIMIT 1) AS hours
           FROM lab_sessions s WHERE s.state IN ('deploying', 'running', 'failed', 'tearing_down')`,
      ).all<BudgetLab>(),
      env.DB.prepare("SELECT day, SUM(gbp) AS gbp FROM lab_cost_days WHERE day >= ?1 GROUP BY day").bind(`${month}-01`).all<{ day: string; gbp: number }>(),
    ]);
    return { labs: labs.results, labDays: labDays.results };
  } catch (e) {
    console.error("budget labs:", e);
    return { labs: [], labDays: [] };
  }
}

/** Where the budget stands right now. */
export async function budgetStatus(env: Env, cfg?: Config, snap?: Snapshot, now = new Date()): Promise<BudgetStatus> {
  const month = now.toISOString().slice(0, 7);
  const [c, s, days, sent, lab] = await Promise.all([cfg ?? effectiveConfig(env), snap ?? getSnapshot(env), db.costDays(env, `${month}-01`), env.STATUS.get(alertKey(month)), budgetLabs(env, month)]);
  const f = budgetFigures({ budget: c.monthlyBudgetGbp, days, snap: s, hourlyRate: c.hourlyRateGbp, now, labs: lab.labs, labDays: lab.labDays });
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
  // The labs' share, named (labs spec §9.3): Azure's lab spend so far and the live labs to their timers.
  const lab = await budgetLabs(env, b.month);
  const monthStart = Date.parse(`${b.month}-01T00:00:00Z`);
  const labActual = lab.labDays.filter((d) => d.day.startsWith(b.month)).reduce((a, d) => a + d.gbp, 0);
  const labSession = labsEstimate(lab.labs, lab.labDays, now, monthStart, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).getTime());
  const vmSession = b.session - labSession;
  const sums =
    `${money(b.actual)} spent in Azure so far${labActual > 0 ? ` (${money(labActual)} of it on labs)` : ""}` +
    `${vmSession > 1e-9 ? ` plus about ${money(vmSession)} for the VM running now, to its timer` : ""}` +
    `${labSession > 0 ? ` plus about ${money(labSession)} for ${lab.labs.length} lab${lab.labs.length === 1 ? "" : "s"} running now, to ${lab.labs.length === 1 ? "its timer" : "their timers"}` : ""}` +
    `: ${Math.round(b.pct)}% of the ${money(b.budget)} monthly budget.`;
  const msg = due === 100 ? `Monthly budget reached. ${sums} Deploy will ask you to confirm until the month ends.` : `80% of the monthly budget used. ${sums}`;
  await db.addAlert(env, "budget", msg);
  await notify(env, due === 100 ? "wg-admin: over budget" : "wg-admin: 80% of budget", msg, { priority: due === 100 ? 4 : 3, tags: ["moneybag"], buttons: [dashboardButton(env, "Open dashboard", "/cost")] });
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
  throw new RunError(`This month is at ${Math.round(b.pct)}% of the ${money(b.budget)} budget. Tick "Deploy anyway" to go ahead.`, "over_budget");
}
