// labs/watch.ts
//
// Plain English: the labs' night watchman (labs spec §7.4). The cron runs it
// every 5 minutes after the gateway's watchman and before the Azure insights
// collector, each in its own try/catch, so a lab problem can never delay the
// gateway's cost guard. It heals missed callbacks, warns 15 minutes before a
// timer, tears down at the timer or max_until, applies the budget, and runs
// the hourly orphan sweep and the daily cost query. At most 20 subrequests
// a run (makeBudget(20)).
//
// Contract stub (plan L0): does nothing. The engine (plan L2) fills it in,
// keeping this name and signature.

import type { Env } from "../env";

/** One watch run. Returns one line per thing it did, for the Worker's log. */
export async function runLabWatch(_env: Env, _now: Date): Promise<string[]> {
  return [];
}
