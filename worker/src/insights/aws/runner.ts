// insights/aws/runner.ts
//
// Plain English: the AWS half of an insights run (spec
// 2026-10-15-aws-insights-design.md, sections 2.4, 3 and 9), called by
// runInsights (insights/runner.ts) with the run's budget, deadline,
// snapshot and settings. It follows the Azure runner's rules:
//
//   1. without the Worker's AWS keys (or with AWS switched off) nothing is
//      fetched and every AWS feed reads not_configured, written only when a
//      row says otherwise,
//   2. reads aws_feed once, then takes the feeds whose `when` holds and that
//      are due, in priority order: "always" feeds whatever the server is
//      doing; "server" and "running" feeds only while the server is in AWS
//      (and not destroyed). A feed that does not apply records nothing new
//      (a row left at not_configured from before the keys were set reads
//      idle),
//   3. runs each in its own try/catch under the shared budget: a feed that
//      would pass the budget, or comes after the deadline, is skipped and
//      stays due, as is one AWS throttles; a failure is an error in plain
//      words and the next feed still runs,
//   4. records every result in aws_feed in one D1 batch at the end.

import type { Env, Config } from "../../env";
import { cloudOf, type Snapshot } from "../../state";
import { AZ_RUN_BUDGET, BudgetExceeded, type Budget, type FeedResult } from "../types";
import { OUT_OF_TIME, dueByRow, feedResultStmt, flushResults, plainError, vmMetricsApply } from "../common";
import { awsPlainError, readAwsFeedRows } from "./common";
import { AwsOutOfTime, makeAwsCtx, type AwsRunShared } from "./ctx";
import { AwsThrottled, awsConfigured, type AwsFeed, type AwsFeedWhen } from "./types";

/** What a feed records when the run's calls ran out before it (it stays due). */
export const AWS_OUT_OF_CALLS = `This run's ${AZ_RUN_BUDGET} outside calls were used up; it runs next time.`;

/** Is the server in AWS and not destroyed (its headend may exist)? */
export function awsServer(snap: Snapshot): boolean {
  return cloudOf(snap) === "aws" && snap.state !== "destroyed";
}

/** Does an AWS feed's `when` hold for this snapshot at `now` (ms)? */
export function awsWhenHolds(when: AwsFeedWhen, snap: Snapshot, now: number): boolean {
  if (when === "always") return true;
  if (!awsServer(snap)) return false;
  if (when === "server") return true;
  return vmMetricsApply(snap, now);
}

/** Without the AWS keys: every AWS feed reads not_configured. One statement; it writes only the rows that say otherwise. */
async function markNotConfigured(db: D1Database, feeds: readonly AwsFeed[]): Promise<void> {
  if (!feeds.length) return;
  const values = feeds.map((_, i) => `(?${i + 1}, 'not_configured', NULL)`).join(", ");
  await db
    .prepare(
      `INSERT INTO aws_feed (feed, status, error) VALUES ${values}
       ON CONFLICT (feed) DO UPDATE SET status = 'not_configured', error = NULL WHERE aws_feed.status <> 'not_configured' OR aws_feed.error IS NOT NULL`,
    )
    .bind(...feeds.map((f) => f.id))
    .run();
}

/** A feed that does not apply now and has never run (or was not_configured): idle, its times kept. */
function idleStmt(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("INSERT INTO aws_feed (feed, status, error) VALUES (?1, 'idle', NULL) ON CONFLICT (feed) DO UPDATE SET status = 'idle', error = NULL").bind(id);
}

/** Run the due AWS feeds. Answers one line per thing worth logging (errors and skips). */
export async function runAwsInsights(env: Env, now: Date, feeds: readonly AwsFeed[], opts: { budget: Budget; late: () => boolean; snap: Snapshot; cfg: Config }): Promise<string[]> {
  if (!awsConfigured(env)) {
    await markNotConfigured(env.DB, feeds);
    return [];
  }
  const { budget, late, snap, cfg } = opts;
  const lines: string[] = [];
  const rows = await readAwsFeedRows(env.DB);
  const shared: AwsRunShared = {};
  const pending: { id: string; stmt: D1PreparedStatement }[] = [];
  try {
    for (const f of feeds) {
      const row = rows.get(f.id) ?? null;
      if (!awsWhenHolds(f.when, snap, now.getTime())) {
        if (!row || row.status === "not_configured") pending.push({ id: f.id, stmt: idleStmt(env.DB, f.id) });
        continue;
      }
      const ctx = makeAwsCtx(env, now, snap, cfg, budget, { row, late, shared });
      let result: FeedResult;
      try {
        if (!(await (f.due ? f.due(ctx, row) : dueByRow(row, now)))) continue;
        if (late()) result = { status: "skipped", error: OUT_OF_TIME };
        else if (f.calls > budget.remaining()) result = { status: "skipped", error: AWS_OUT_OF_CALLS };
        else result = await f.run(ctx);
      } catch (e) {
        if (e instanceof BudgetExceeded) result = { status: "skipped", error: AWS_OUT_OF_CALLS };
        else if (e instanceof AwsOutOfTime) result = { status: "skipped", error: OUT_OF_TIME };
        else if (e instanceof AwsThrottled) result = { status: "skipped", error: e.message };
        else result = { status: "error", error: awsPlainError(e) };
      }
      if (result.status !== "ok") lines.push(`${f.id} ${result.status}${result.error ? `: ${plainError(result.error)}` : ""}`);
      pending.push({ id: f.id, stmt: feedResultStmt(env.DB, "aws_feed", f.id, now, result, row, f.cadenceMin) });
    }
  } finally {
    await flushResults(env.DB, pending, lines);
  }
  return lines;
}

/** Record an on-demand run of an AWS feed (POST boot log) like a cron run. */
export async function recordAwsFeedResult(env: Env, id: AwsFeed["id"], now: Date, r: FeedResult, cadenceMin: number | null = null): Promise<void> {
  const row = (await readAwsFeedRows(env.DB)).get(id) ?? null;
  await feedResultStmt(env.DB, "aws_feed", id, now, r, row, cadenceMin).run();
}
