// labs/watch.ts
//
// Plain English: the labs' night watchman (labs spec §7.4). The cron runs it
// every 5 minutes after the gateway's watchman and before the Azure insights
// collector, each in its own try/catch, so a lab problem can never delay the
// gateway's cost guard. In order of what matters most:
//
//   1. At the timer (auto_destroy_at): destroy, reason timer. At max_until:
//      destroy, reason max; nothing moves max_until.
//   2. Cost guard: still running 15 minutes past its deadline (the first
//      tear-down did not start), or a tear-down stuck past its workflow's
//      timeout: destroy again, with one watchman note per session. A failed
//      session (a failed deploy, a destroy with no clean check) is destroyed
//      after 15 minutes, reason failed.
//   3. 15 minutes before a session ends: one push with Extend 1h (left out
//      when max_until is under an hour away) and Tear down.
//   4. Every run in progress is re-read from GitHub (missed callbacks heal).
//
// Every outside call goes through one Net of WATCH_CALLS (20): the
// tear-downs take theirs first; when the allowance runs out the rest waits
// for the next run, five minutes later. Each lab is handled in its own
// try/catch, so one lab's problem never stops another's tear-down. The
// gateway's workflow is never dispatched from here.

import type { Env } from "../env";
import { canDispatch } from "../env";
import * as db from "../db";
import { notify } from "../notify";
import { canPush } from "../webpush";
import { actionButton, dashboardButton } from "../actions";
import { plainError } from "../insights/common";
import { LAB_GRACE_MIN } from "../../../shared/labs";
import { labDef } from "./catalogue";
import { budgetedNet, BudgetExceeded, type Net } from "./net";
import { destroySession, hhmm, timeoutOf } from "./engine";
import { activeRunOf, activeRuns, getSession, liveSessions, payloadOf, runsOf, updateSession, type LabSessionRow } from "./store";
import { refreshLabRun } from "./refresh";
import { budgetStatus } from "../budget";
import { fetchLabCostDays } from "./cost";
import { sweepOrphans } from "./orphans";
import { proposeLabsRule } from "./fwproposal";
import { labTitle } from "./view";

const MIN = 60_000;
const HOUR = 60 * MIN;
const GRACE = LAB_GRACE_MIN * MIN;

/** The most outside calls (GitHub, Azure, Graph, notifications) one watch run makes (plan: makeBudget(20)). */
export const WATCH_CALLS = 20;

/** What one notification costs in outside calls: the webhook, plus one per subscribed phone. */
async function pushCost(env: Env): Promise<number> {
  const phones = canPush(env) ? (await db.listPushSubs(env).catch(() => [])).length : 0;
  return (env.NOTIFY_WEBHOOK_URL ? 1 : 0) + phones;
}

/** Push, if the run's allowance covers it; a push is worth less than a tear-down, so it never throws. */
async function pushIfCalls(env: Env, net: Net, cost: number, title: string, body: string, opts: Parameters<typeof notify>[3]): Promise<boolean> {
  try {
    net.take(cost);
  } catch {
    return false;
  }
  await notify(env, title, body, opts);
  return true;
}

/** The cost guard's note: once per session (KV, two days). */
async function guardNote(env: Env, net: Net, cost: number, s: LabSessionRow, msg: string): Promise<void> {
  const key = `labs:guard:${s.id}`;
  if (await env.STATUS.get(key)) return;
  await env.STATUS.put(key, "1", { expirationTtl: 2 * 86_400 });
  await db.addAlert(env, "cost_guard", msg);
  await pushIfCalls(env, net, cost, "wg-admin: lab cost guard", msg, { priority: 4, tags: ["rotating_light"], buttons: [dashboardButton(env, "Open Labs", "/labs")] });
}

/** When the session's last run finished (or it was requested, with none). */
async function lastFinished(env: Env, s: LabSessionRow): Promise<number> {
  const runs = await runsOf(env, s.id);
  const t = runs.map((r) => Date.parse(r.finished_at ?? "")).filter(Number.isFinite);
  return t.length ? Math.max(...t) : Date.parse(s.requested_at);
}

/** Steps 1 and 2 for one session. Returns a log line when it did something. */
async function timers(env: Env, s: LabSessionRow, net: Net, cost: number, now: number): Promise<string | null> {
  const title = labTitle(s.lab_id);
  const max = Date.parse(s.max_until);
  const auto = s.auto_destroy_at ? Date.parse(s.auto_destroy_at) : Infinity;
  const deadline = Math.min(max, auto);
  const by = "watchman";

  if (s.state === "running" || (s.state === "deploying" && now >= max)) {
    if (now < deadline) return null;
    const reason = now >= max ? "max" : "timer";
    if (now >= deadline + GRACE) {
      await guardNote(env, net, cost, s, `Cost guard: lab ${title} was still ${s.state} 15 minutes past its deadline (${hhmm(deadline)}). Tearing it down again.`);
      await destroySession(env, s, reason, by, "cost guard: still running 15 minutes past its deadline", { net });
      return `${title}: cost guard, tearing down`;
    }
    await destroySession(env, s, reason, by, reason === "max" ? "maximum lifetime reached" : "auto-destroy timer", { net });
    return `${title}: ${reason === "max" ? "maximum lifetime" : "timer"} reached, tearing down`;
  }

  if (s.state === "failed" || s.state === "deploying") {
    // deploying with no run going is a deploy that died without a word: the same as failed.
    if (s.state === "deploying" && (await activeRunOf(env, s.id))) return null;
    if (now - (await lastFinished(env, s)) < GRACE) return null;
    await destroySession(env, s, "failed", by, `failed ${LAB_GRACE_MIN} minutes ago; cleaning up`, { net });
    return `${title}: failed ${LAB_GRACE_MIN} min ago, tearing down`;
  }

  if (s.state === "tearing_down") {
    const active = await activeRunOf(env, s.id);
    const stuck = active ? now - Date.parse(active.requested_at) >= (timeoutOf(labDef(s.lab_id)) + LAB_GRACE_MIN) * MIN : now - (await lastFinished(env, s)) >= GRACE;
    if (!stuck) return null;
    await guardNote(env, net, cost, s, `Cost guard: lab ${title}'s tear-down did not finish (no result after its workflow's time limit). Tearing it down again.`);
    await destroySession(env, s, s.end_reason === "max" ? "max" : "timer", by, "cost guard: the tear-down did not finish", { net, again: true });
    return `${title}: tear-down stuck, tearing down again`;
  }
  return null;
}

/** Step 3: the 15-minute warning, once per deadline (warned_at; Extend clears it). */
async function warn(env: Env, s: LabSessionRow, net: Net, cost: number, now: number): Promise<string | null> {
  if (s.state !== "running" || s.test || s.warned_at) return null;
  const max = Date.parse(s.max_until);
  const deadline = Math.min(max, s.auto_destroy_at ? Date.parse(s.auto_destroy_at) : Infinity);
  const left = deadline - now;
  if (!(left > 0 && left <= GRACE)) return null;
  const title = labTitle(s.lab_id);
  const atMax = deadline >= max;
  // Extend 1h is offered only while it could really add time: max_until an hour or more away.
  const extendable = !atMax && max - now >= HOUR;
  try {
    net.take(cost);
  } catch (e) {
    if (e instanceof BudgetExceeded) return null; // next run, five minutes on, still inside the window
    throw e;
  }
  if (!(await updateSession(env, s.id, { warned_at: new Date(now).toISOString() }, "warned_at IS NULL"))) return null;
  const ttl = Math.round(left / 1000) + 30 * 60;
  const buttons = [
    ...(extendable ? [await actionButton(env, `lab-extend-1h:${s.id}`, ttl)] : []),
    await actionButton(env, `lab-destroy:${s.id}`, ttl),
    dashboardButton(env, "Open the lab", `/labs/${s.lab_id}`),
  ];
  const mins = Math.max(1, Math.round(left / MIN));
  const body = atMax
    ? `${title} reaches its maximum lifetime at ${hhmm(deadline)} and is torn down then. Tear it down now if you are done.`
    : `${title}'s timer ends at ${hhmm(deadline)}.${extendable ? " Extend it by an hour, or let it tear down." : " It cannot be extended past its maximum lifetime."}`;
  await notify(env, `wg-admin: lab ${title} ends in ${mins} min`, body, { priority: 4, tags: ["hourglass"], buttons });
  return `${title}: 15-minute warning sent`;
}

/** One watch run. Returns one line per thing it did, for the Worker's log. */
export async function runLabWatch(env: Env, now: Date = new Date()): Promise<string[]> {
  const lines: string[] = [];
  const net = budgetedNet(WATCH_CALLS);
  const t = now.getTime();
  const step = async (name: string, fn: () => Promise<string | null | void>) => {
    try {
      const line = await fn();
      if (line) lines.push(line);
    } catch (e) {
      lines.push(e instanceof BudgetExceeded ? `${name}: out of calls for this run` : `${name}: ${plainError(e)}`);
    }
  };

  if (canDispatch(env)) {
    const cost = await pushCost(env);
    // 0: the month's budget: at 100% every lab goes (deploying ones cancelled first). Never the gateway.
    await step("budget", () => budgetTeardown(env, net, cost, now));
    // 1 and 2: timers, max_until, the cost guard and failed sessions, first.
    for (const s of await liveSessions(env)) {
      await step(`lab ${s.lab_id}`, async () => {
        const fresh = await getSession(env, s.id);
        return fresh ? timers(env, fresh, net, cost, t) : null;
      });
    }
    // 3: the 15-minute warnings.
    for (const s of await liveSessions(env)) await step(`warn ${s.lab_id}`, () => warn(env, s, net, cost, t));
    // 4: runs in progress, from GitHub.
    // A settled run may push (ready, leftovers): only while this run's allowance covers it.
    const canNotify = () => {
      try {
        net.take(cost);
        return true;
      } catch {
        return false;
      }
    };
    for (const run of await activeRuns(env)) await step(`refresh ${run.id}`, () => refreshLabRun(env, run, net, now, canNotify));
  }
  // 5: hourly, the orphan sweep (7 listings); 6: daily, Azure's spend per lab group.
  await step("orphans", () => sweepOrphans(env, net, now));
  await step("lab costs", () => fetchLabCostDays(env, net, now));
  // 7: once per install, the Labs firewall rule as a draft proposal (D1 only).
  await step("firewall", () => proposeLabsRule(env));
  return lines;
}

/**
 * Spec §7.4 step 5: at or over 100% of the month's budget (§9.3), tear down
 * every live lab, reason budget: a deploy in progress is cancelled first. A
 * session deployed with "Deploy anyway" while over budget is left alone (it
 * was a deliberate choice). Sessions already tearing down are not touched
 * again. Only lab.yml is ever dispatched; the gateway runs on.
 */
async function budgetTeardown(env: Env, net: Net, cost: number, now: Date): Promise<string | null> {
  const b = await budgetStatus(env, undefined, undefined, now);
  if (b.level !== "over") return null;
  const gone: string[] = [];
  const failed: string[] = [];
  for (const s of await liveSessions(env)) {
    if (s.state === "tearing_down") continue;
    const first = (await runsOf(env, s.id)).filter((r) => r.action === "deploy" || r.action === "test").at(-1) ?? null;
    if (payloadOf(first).overBudgetOk === true) continue;
    try {
      await destroySession(env, s, "budget", "watchman", "monthly budget reached", { net });
      gone.push(labTitle(s.lab_id));
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      failed.push(`${labTitle(s.lab_id)} (${plainError(e)})`);
    }
  }
  if (!gone.length && !failed.length) return null;
  const msg = `Monthly budget reached (${Math.round(b.pct)}% of £${b.budget.toFixed(2)}): ${gone.length ? `tearing down ${gone.length} lab${gone.length === 1 ? "" : "s"} (${gone.join(", ")})` : "no lab could be torn down yet"}${failed.length ? `; could not start: ${failed.join(", ")}, tried again in 5 minutes` : ""}. The gateway is not touched.`;
  await db.addAlert(env, "cost_guard", msg);
  await pushIfCalls(env, net, cost, "wg-admin: budget reached, labs torn down", msg, { priority: 4, tags: ["moneybag"], buttons: [dashboardButton(env, "Open Labs", "/labs")] });
  return `budget: ${msg}`;
}
