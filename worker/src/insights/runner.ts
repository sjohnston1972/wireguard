// insights/runner.ts
//
// Plain English: the Azure insights collector, run by the second cron
// (INSIGHTS_CRON in insights/types.ts) in its own invocation, so nothing it
// does can delay the watchman. X0 ships it as a no-op; area X1 replaces the
// body: read az_feed, run the due feeds in priority order under the budget,
// each isolated, and record each result.

import type { Env } from "../env";

/** Run the due feeds. Answers one line per thing worth logging (none yet). */
export async function runInsights(_env: Env, _now: Date = new Date()): Promise<string[]> {
  return [];
}
