// insights/runner.ts
//
// Plain English: the Azure insights collector, run by the second cron
// (INSIGHTS_CRON in insights/types.ts) in its own invocation, so nothing it
// does can delay the watchman. Each run:
//
//   1. reads az_feed once (when each feed last ran and is next due),
//   2. takes the feeds that are due and apply now (the VM running, the
//      resource group existing, ...), in the spec's priority order,
//   3. runs each one on its own: its own try/catch, every outside call
//      aborted after 8 s, and every call taken from one budget of 25 per
//      run. A feed that would pass the budget is skipped and stays due; a
//      feed that fails is recorded as an error and the next one still runs,
//   4. records every result in az_feed in one D1 batch at the end (errors
//      in plain words, never a URL), also when the run fails or runs out
//      of time part-way.
//
// Time: the collector runs in waitUntil, which the platform ends about 30 s
// after the cron event. Past RUN_SOFT_DEADLINE_MS the runner sends no more
// outside calls and starts no more feeds (they are recorded as skipped and
// stay due), so the one batch is always written before that hard stop.
//
// D1 per run (worst case, every feed due, measured in api-azure.test.ts):
// 70 statements in 31 round trips; it was 80 in 50 when each feed read and
// wrote az_feed on its own.
//
// The sign-in to Azure happens once, at the first feed that needs it. If it
// fails, every feed that talks to Azure Resource Manager is recorded as an
// error; the price feed, which needs no sign-in, still runs. Without the
// service principal secrets nothing is fetched and every feed reads
// not_configured.
//
// AWS (spec 2026-10-15-aws-insights-design.md, sections 2.4 and 3): the AWS
// feeds (insights/aws/) run in the same run, under the same budget of 25,
// when the Worker's AWS keys are set. While the server is in AWS, Azure's
// server feeds (every `when` but "always") are recorded skipped, "The server
// runs in AWS.", and the AWS feeds go first; Azure's cloud-wide feeds still
// run when Azure is configured. Otherwise Azure's feeds go first.

import type { Env } from "../env";
import { arm as armCall, armToken } from "../azure";
import { effectiveConfig } from "../settings";
import { cloudOf, getSnapshot, type Snapshot } from "../state";
import { AZ_RUN_BUDGET, BudgetExceeded, FEED_IDS, insightsConfigured, makeBudget, type Budget, type Feed, type FeedCtx, type FeedResult, type FeedWhen, type InsightsFeedId } from "./types";
import { FETCH_TIMEOUT_MS, OUT_OF_TIME, dueByRow, feedResultStmt, flushResults, markDueStmt, plainError, readFeedRows, rgExists, vmExists, vmMetricsApply, withTimeout, type FeedRow } from "./common";
import { runAwsInsights } from "./aws/runner";
import { AWS_FEED_MODULES } from "./aws/feeds/index";
import type { AwsFeed } from "./aws/types";
import health from "./feeds/health";
import vmMetrics from "./feeds/vmMetrics";
import pipMetrics from "./feeds/pipMetrics";
import metricDefs from "./feeds/metricDefs";
import activity from "./feeds/activity";
import serviceHealth from "./feeds/serviceHealth";
import capacity from "./feeds/capacity";
import prices from "./feeds/prices";
import bootLog from "./feeds/bootLog";
import housekeeping from "./feeds/housekeeping";

/** A feed as the runner holds it: the frozen Feed, plus whether it signs in to ARM and any extra rule for being due. */
export interface FeedModule extends Feed {
  /** True when its calls go to Azure Resource Manager (they need the sign-in); false for the price API and housekeeping. */
  arm: boolean;
  /** Overrides the plain "next_due_at has passed" rule (the boot log, metric names after a deploy). */
  due?(ctx: FeedCtx, row: FeedRow | null): boolean | Promise<boolean>;
}

/** Every feed, in the runner's priority order (spec section 4), then the daily prune. */
export const FEED_MODULES: readonly FeedModule[] = [health, vmMetrics, pipMetrics, metricDefs, activity, serviceHealth, capacity, prices, bootLog, housekeeping];

/** Every outside call is given up after this long (common.ts, shared with the AWS runner). */
export { FETCH_TIMEOUT_MS };
/**
 * After this long (wall time) a run sends no more outside calls and starts no
 * more feeds. One call in flight can take 8 s more, which still leaves the
 * results' batch inside waitUntil's 30 s.
 */
export const RUN_SOFT_DEADLINE_MS = 18_000;

const OUT_OF_CALLS = `This run's ${AZ_RUN_BUDGET} Azure calls were used up; it runs next time.`;
/** What an Azure server feed records while the server is in AWS (its AWS twin runs instead). */
export const AWS_SKIP = "The server runs in AWS.";

/** Thrown before an outside call once the run is past RUN_SOFT_DEADLINE_MS. Ends the feed as skipped. */
class RunOutOfTime extends Error {
  constructor() {
    super(OUT_OF_TIME);
    this.name = "RunOutOfTime";
  }
}

/** Does a feed's `when` hold for this snapshot at `now` (ms)? */
export function whenHolds(when: FeedWhen, snap: Snapshot, now: number): boolean {
  if (when === "always") return true;
  if (when === "rg") return rgExists(snap);
  if (when === "vm") return vmExists(snap);
  return vmMetricsApply(snap, now);
}

class FetchTimeout extends Error {
  constructor() {
    super(`An Azure call took longer than ${FETCH_TIMEOUT_MS / 1000} s and was given up.`);
    this.name = "FetchTimeout";
  }
}

class SignInFailed extends Error {
  constructor(why: string) {
    super(`Azure sign-in failed: ${why}`);
    this.name = "SignInFailed";
  }
}

/** Run `make` with an abort signal that fires after 8 s; the race also ends a call that ignores its signal. */
function timed<T>(make: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withTimeout(make, () => new FetchTimeout());
}

const ARM_ORIGIN = "https://management.azure.com";

/** A token cached in KV (by armToken, shared with the watchman) that is good for another minute. */
async function tokenCached(env: Env): Promise<boolean> {
  try {
    const c = await env.STATUS.get<{ token: string; expiresAt: number }>("azure:token", "json");
    return !!c && c.expiresAt > Date.now() + 60_000;
  } catch {
    return false;
  }
}

/** What the runner adds to one feed's ctx: its row, markDue, and the run's deadline. */
interface RunParts {
  row?: FeedRow | null;
  markDue?(feed: string): void;
  /** True once the run is past its deadline: no more outside calls. */
  late?(): boolean;
}

/** The ctx one feed runs with, sharing the run's budget and sign-in. */
function makeCtx(env: Env, now: Date, snap: Snapshot, cfg: FeedCtx["cfg"], budget: Budget, signIn: () => Promise<void>, run: RunParts = {}): FeedCtx {
  const inTime = () => {
    if (run.late?.()) throw new RunOutOfTime();
  };
  return {
    env,
    db: env.DB,
    now,
    snap,
    cfg,
    budget,
    ...("row" in run ? { row: run.row ?? null } : {}),
    ...(run.markDue ? { markDue: run.markDue } : {}),
    async arm(path, init = {}) {
      let p = path;
      if (/^https?:\/\//i.test(p)) {
        // A next-page link Azure gave: follow it only on ARM itself, so the token never goes anywhere else.
        if (!p.startsWith(`${ARM_ORIGIN}/`)) throw new Error("Azure gave a next-page link to another host; it was not followed.");
        p = p.slice(ARM_ORIGIN.length);
      }
      inTime();
      await signIn();
      inTime();
      budget.take(1);
      try {
        return await timed((signal) => armCall(env, p, { ...init, signal }));
      } catch (e) {
        if (e instanceof FetchTimeout || e instanceof BudgetExceeded) throw e;
        throw new Error(`A call to Azure failed (${(e as Error)?.name ?? "error"}).`);
      }
    },
    async fetch(url, init = {}) {
      inTime();
      budget.take(1);
      try {
        return await timed((signal) => fetch(url, { ...init, signal }));
      } catch (e) {
        if (e instanceof FetchTimeout) throw e;
        // Never quote the URL: a boot log's carries a signature.
        throw new Error(`An outside call failed (${(e as Error)?.name ?? "error"}).`);
      }
    },
  };
}

/** Is the feed due by its row (or its own rule)? */
async function isDue(f: FeedModule, row: FeedRow | null, ctx: FeedCtx): Promise<boolean> {
  if (f.due) return f.due(ctx, row);
  return dueByRow(row, ctx.now);
}

/** The az_feed write for one feed's result. */
function recordStmt(env: Env, id: InsightsFeedId, now: Date, r: FeedResult, row: FeedRow | null, cadenceMin: number | null): D1PreparedStatement {
  return feedResultStmt(env.DB, "az_feed", id, now, r, row, cadenceMin);
}

/** Record an on-demand run of a feed (POST boot log) like a cron run. */
export async function recordFeedResult(env: Env, id: InsightsFeedId, now: Date, r: FeedResult): Promise<void> {
  const row = (await readFeedRows(env.DB)).get(id) ?? null;
  const cadence = FEED_MODULES.find((f) => f.id === id)?.cadenceMin ?? null;
  await recordStmt(env, id, now, r, row, cadence).run();
}

/** Write the run's results in one batch (each on its own if the batch fails). */
function flush(env: Env, stmts: { id: string; stmt: D1PreparedStatement }[], lines: string[]): Promise<void> {
  return flushResults(env.DB, stmts, lines);
}

/** Without credentials: every feed reads not_configured. Only rows that say otherwise are written. */
async function markNotConfigured(env: Env, feeds: readonly FeedModule[]): Promise<void> {
  const rows = await readFeedRows(env.DB);
  const stmts = feeds
    .filter((f) => rows.get(f.id)?.status !== "not_configured")
    .map((f) =>
      env.DB.prepare("INSERT INTO az_feed (feed, status, error) VALUES (?1, 'not_configured', NULL) ON CONFLICT (feed) DO UPDATE SET status = 'not_configured', error = NULL").bind(f.id),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

/** The sign-in, once, at the first ARM call (1 call from the budget unless the token is cached); a failure is remembered. */
function signInOnce(env: Env, budget: Budget): () => Promise<void> {
  let signedIn: Promise<void> | null = null;
  return () =>
    (signedIn ??= (async () => {
      if (!(await tokenCached(env))) budget.take(1);
      try {
        await timed(() => armToken(env));
      } catch (e) {
        throw new SignInFailed(e instanceof FetchTimeout ? "no answer in 8 s" : plainError(e));
      }
    })());
}

/**
 * A ctx for one on-demand job outside the cron (POST boot log, a capacity
 * cache miss), with its own small budget, the same sign-in, timeouts and
 * error rules as a feed.
 */
export async function oneOffCtx(env: Env, now: Date, limit: number): Promise<FeedCtx> {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  const budget = makeBudget(limit);
  return makeCtx(env, now, snap, cfg, budget, signInOnce(env, budget));
}

export interface RunOptions {
  /** Wall-clock ms for the run's deadline (tests); Date.now by default. */
  clock?: () => number;
  /** The cron's shared allowance (cron.ts): the run takes at most AZ_RUN_BUDGET of what the watchman and the lab watch left. */
  parent?: Budget;
  /**
   * The AWS feeds to run beside `feeds`. Default: AWS_FEED_MODULES when
   * `feeds` is the default list, none when a test passes its own Azure feeds
   * (so a test of Azure stand-ins never runs the real AWS feeds).
   */
  awsFeeds?: readonly AwsFeed[];
}

/** Run the due feeds. Answers one line per thing worth logging (errors and skips). */
export async function runInsights(env: Env, now: Date = new Date(), feeds: readonly FeedModule[] = FEED_MODULES, opts: RunOptions = {}): Promise<string[]> {
  const awsFeeds = opts.awsFeeds ?? (feeds === FEED_MODULES ? AWS_FEED_MODULES : []);
  const azure = insightsConfigured(env);
  if (!azure) {
    await markNotConfigured(env, feeds);
    if (!awsFeeds.length) return [];
  }
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const late = () => clock() - started >= RUN_SOFT_DEADLINE_MS;
  const lines: string[] = [];
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  // One budget for both clouds: the run never passes AZ_RUN_BUDGET (nor what the cron left).
  const budget = makeBudget(AZ_RUN_BUDGET, opts.parent);
  const runAzure = async () => {
    if (azure) await runAzureFeeds(env, now, feeds, { budget, late, snap, cfg, lines });
  };
  const runAws = async () => {
    if (awsFeeds.length) lines.push(...(await runAwsInsights(env, now, awsFeeds, { budget, late, snap, cfg })));
  };
  // The server's own cloud first, so its server feeds get the calls; each half is recorded even if the other fails.
  const order = cloudOf(snap) === "aws" && snap.state !== "destroyed" ? [runAws, runAzure] : [runAzure, runAws];
  let failure: unknown = null;
  for (const half of order) {
    try {
      await half();
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure !== null) throw failure;
  return lines;
}

/** The Azure half of a run (Azure configured): the due feeds, in order, then their results in one batch. */
async function runAzureFeeds(env: Env, now: Date, feeds: readonly FeedModule[], run: { budget: Budget; late: () => boolean; snap: Snapshot; cfg: FeedCtx["cfg"]; lines: string[] }): Promise<void> {
  const { budget, late, snap, cfg, lines } = run;
  const rows = await readFeedRows(env.DB);
  // The server is in AWS: Azure's server feeds have nothing to collect (their AWS twins run instead); its cloud-wide feeds still run.
  const serverInAws = cloudOf(snap) === "aws" && snap.state !== "destroyed";
  const signIn = signInOnce(env, budget);
  const pending: { id: string; stmt: D1PreparedStatement }[] = [];
  const recorded = new Set<string>();
  const madeDue = new Set<string>();
  // An earlier feed may make a later one due (metric names after a refused metrics call): this run sees it at once.
  const markDue = (feed: string) => {
    madeDue.add(feed);
    const r = rows.get(feed);
    if (r) rows.set(feed, { ...r, next_due_at: null });
  };

  try {
    for (const f of feeds) {
      if (serverInAws && f.when !== "always") {
        pending.push({ id: f.id, stmt: recordStmt(env, f.id, now, { status: "skipped", error: AWS_SKIP }, rows.get(f.id) ?? null, f.cadenceMin) });
        recorded.add(f.id);
        continue;
      }
      if (!whenHolds(f.when, snap, now.getTime())) continue;
      const row = rows.get(f.id) ?? null;
      const ctx = makeCtx(env, now, snap, cfg, budget, signIn, { row, markDue, late });
      if (!(await isDue(f, row, ctx))) continue;

      let result: FeedResult;
      if (late()) {
        result = { status: "skipped", error: OUT_OF_TIME };
      } else if (f.calls > budget.remaining()) {
        result = { status: "skipped", error: OUT_OF_CALLS };
      } else {
        try {
          if (f.arm) await signIn();
          result = await f.run(ctx);
        } catch (e) {
          if (e instanceof BudgetExceeded) result = { status: "skipped", error: OUT_OF_CALLS };
          else if (e instanceof RunOutOfTime) result = { status: "skipped", error: OUT_OF_TIME };
          else result = { status: "error", error: plainError(e) };
        }
      }
      if (result.status !== "ok") lines.push(`${f.id} ${result.status}${result.error ? `: ${plainError(result.error)}` : ""}`);
      // A skipped feed stays due: keep a markDue it was given in this run.
      pending.push({ id: f.id, stmt: recordStmt(env, f.id, now, result, rows.get(f.id) ?? null, f.cadenceMin) });
      recorded.add(f.id);
    }
  } finally {
    for (const id of madeDue) if (!recorded.has(id)) pending.push({ id, stmt: markDueStmt(env.DB, id) });
    await flush(env, pending, lines);
  }
}

/** The ids the runner knows, for checks. */
export const RUNNER_FEED_IDS: readonly InsightsFeedId[] = [...FEED_IDS, "housekeeping"];
