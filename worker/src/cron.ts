// cron.ts
//
// Plain English: the one */5 cron invocation (wrangler.toml), which runs the
// gateway's watchman (monitor.ts), then the labs' watch (labs/watch.ts), then
// the Azure insights collector (insights/runner.ts). Cloudflare's Free plan
// allows 50 outside calls (subrequests) per invocation, and the three alone
// can want 28 + 20 + 25. So they share ONE allowance, CRON_CALLS (45, five
// spare), spent in order of what matters most:
//
//   1. The watchman: the gateway's cost guard. Never refused. Its calls come
//      from many modules through plain fetch, so they are counted as they go
//      and taken from the allowance afterwards.
//   2. The lab watch: at most its own WATCH_CALLS (20) of what is left. Inside
//      it the tear-downs come first (budget, timers, max lifetime, cost guard,
//      failed sessions), then warnings, run refreshes, the orphan sweep and the
//      cost query.
//   3. Insights: at most its own AZ_RUN_BUDGET (25) of what is left.
//
// What does not fit waits for the next run, five minutes on: a lab session is
// still past its timer, and a skipped insights feed is recorded "skipped" and
// stays due. Each stage is caught on its own, so none can stop the others.

import type { Env } from "./env";
import { runScheduled } from "./monitor";
import { runLabWatch } from "./labs/watch";
import { runInsights } from "./insights/runner";
import { makeBudget, type Budget } from "./insights/types";

/** Outside calls one cron invocation may make: Cloudflare Free allows 50; five are kept spare. */
export const CRON_CALLS = 45;

export interface CronStages {
  watchman: (env: Env, now: Date) => Promise<string[]>;
  labs: (env: Env, now: Date, parent: Budget) => Promise<string[]>;
  insights: (env: Env, now: Date, parent: Budget) => Promise<string[]>;
}

const STAGES: CronStages = {
  watchman: (env, now) => runScheduled(env, now),
  labs: (env, now, parent) => runLabWatch(env, now, { parent }),
  insights: (env, now, parent) => runInsights(env, now, undefined, { parent }), // the default feeds
};

/**
 * Run `fn`, counting every fetch made meanwhile. A request served at the same
 * moment in this isolate would be counted too: that only ever over-counts,
 * which leaves more calls spare, never fewer.
 */
async function counted<T>(fn: () => Promise<T>): Promise<{ calls: number; value: T }> {
  const inner = globalThis.fetch;
  let calls = 0;
  const meter: typeof fetch = (...args) => {
    calls++;
    return inner(...args);
  };
  globalThis.fetch = meter;
  try {
    const value = await fn();
    return { calls, value };
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { calls });
  } finally {
    if (globalThis.fetch === meter) globalThis.fetch = inner;
  }
}

/** One cron run. Never throws; answers the log lines and how many calls were spent. */
export async function runCron(env: Env, now: Date, stages: CronStages = STAGES): Promise<{ lines: string[]; used: number }> {
  const allowance = makeBudget(CRON_CALLS);
  const lines: string[] = [];

  // 1. The watchman, counted, never refused.
  let watchmanCalls = 0;
  try {
    const r = await counted(() => stages.watchman(env, now));
    watchmanCalls = r.calls;
    if (r.value.length) lines.push(`watchman: ${r.value.join(" | ")}`);
  } catch (e) {
    watchmanCalls = Number((e as { calls?: number }).calls ?? 0);
    console.error("watchman run failed:", e);
  }
  allowance.take(Math.min(watchmanCalls, allowance.remaining()));
  if (watchmanCalls > CRON_CALLS) lines.push(`watchman: made ${watchmanCalls} calls, over the cron's ${CRON_CALLS}`);

  // 2. The lab watch, its tear-downs first.
  try {
    const r = await stages.labs(env, now, allowance);
    if (r.length) lines.push(`lab watch: ${r.join(" | ")}`);
  } catch (e) {
    console.error("lab watch failed:", e);
  }

  // 3. Insights, with what is left.
  try {
    const r = await stages.insights(env, now, allowance);
    if (r.length) lines.push(`insights: ${r.join(" | ")}`);
  } catch (e) {
    console.error("insights run failed:", e);
  }

  return { lines, used: watchmanCalls > CRON_CALLS ? watchmanCalls : allowance.used() };
}
