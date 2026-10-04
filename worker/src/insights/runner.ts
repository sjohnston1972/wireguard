// insights/runner.ts
//
// Plain English: the Azure insights collector, run by the second cron
// (INSIGHTS_CRON in insights/types.ts) in its own invocation, so nothing it
// does can delay the watchman. Each run:
//
//   1. reads az_feed (when each feed last ran and is next due),
//   2. takes the feeds that are due and apply now (the VM running, the
//      resource group existing, ...), in the spec's priority order,
//   3. runs each one on its own: its own try/catch, every outside call
//      aborted after 8 s, and every call taken from one budget of 25 per
//      run. A feed that would pass the budget is skipped and stays due; a
//      feed that fails is recorded as an error and the next one still runs,
//   4. records each result in az_feed (errors in plain words, never a URL).
//
// The sign-in to Azure happens once, at the first feed that needs it. If it
// fails, every feed that talks to Azure Resource Manager is recorded as an
// error; the price feed, which needs no sign-in, still runs. Without the
// service principal secrets nothing is fetched and every feed reads
// not_configured.

import type { Env } from "../env";
import { arm as armCall, armToken } from "../azure";
import { effectiveConfig } from "../settings";
import { getSnapshot, type Snapshot } from "../state";
import { AZ_RUN_BUDGET, BudgetExceeded, FEED_IDS, insightsConfigured, makeBudget, type Budget, type Feed, type FeedCtx, type FeedResult, type FeedWhen, type InsightsFeedId } from "./types";
import { MIN, iso, plainError, readFeedRows, rgExists, vmExists, vmMetricsApply, type FeedRow } from "./common";
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

/** Every outside call is given up after this long. */
export const FETCH_TIMEOUT_MS = 8_000;
/** A feed is due a little early, so a cron that fires a few seconds early does not push it back a whole cadence. */
const DUE_SLACK_MS = 30_000;

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
async function timed<T>(make: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new FetchTimeout());
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([make(ac.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

/** The ctx one feed runs with, sharing the run's budget and sign-in. */
function makeCtx(env: Env, now: Date, snap: Snapshot, cfg: FeedCtx["cfg"], budget: Budget, signIn: () => Promise<void>): FeedCtx {
  return {
    env,
    db: env.DB,
    now,
    snap,
    cfg,
    budget,
    async arm(path, init = {}) {
      let p = path;
      if (/^https?:\/\//i.test(p)) {
        // A next-page link Azure gave: follow it only on ARM itself, so the token never goes anywhere else.
        if (!p.startsWith(`${ARM_ORIGIN}/`)) throw new Error("Azure gave a next-page link to another host; it was not followed.");
        p = p.slice(ARM_ORIGIN.length);
      }
      await signIn();
      budget.take(1);
      try {
        return await timed((signal) => armCall(env, p, { ...init, signal }));
      } catch (e) {
        if (e instanceof FetchTimeout || e instanceof BudgetExceeded) throw e;
        throw new Error(`A call to Azure failed (${(e as Error)?.name ?? "error"}).`);
      }
    },
    async fetch(url, init = {}) {
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
  return !row || !row.next_due_at || Date.parse(row.next_due_at) <= ctx.now.getTime() + DUE_SLACK_MS;
}

async function record(env: Env, id: InsightsFeedId, now: Date, r: FeedResult, row: FeedRow | null, cadenceMin: number | null): Promise<void> {
  const at = now.toISOString();
  let next: string | null;
  if (r.status === "skipped") next = row?.next_due_at ?? null; // stays due
  else if (r.nextDueAt) next = r.nextDueAt;
  else next = cadenceMin === null ? null : iso(now.getTime() + cadenceMin * MIN);
  await env.DB.prepare(
    `INSERT INTO az_feed (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (feed) DO UPDATE SET last_try_at = excluded.last_try_at, last_ok_at = COALESCE(excluded.last_ok_at, az_feed.last_ok_at),
       status = excluded.status, error = excluded.error, next_due_at = excluded.next_due_at`,
  )
    .bind(id, at, r.status === "ok" ? at : null, r.status, r.error === null ? null : plainError(r.error), next)
    .run();
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

/** Run the due feeds. Answers one line per thing worth logging (errors and skips). */
export async function runInsights(env: Env, now: Date = new Date(), feeds: readonly FeedModule[] = FEED_MODULES): Promise<string[]> {
  if (!insightsConfigured(env)) {
    await markNotConfigured(env, feeds);
    return [];
  }
  const lines: string[] = [];
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  const budget = makeBudget(AZ_RUN_BUDGET);

  // The sign-in, once, at the first ARM call; a failure is remembered for the rest of the run.
  let signedIn: Promise<void> | null = null;
  const signIn = () =>
    (signedIn ??= (async () => {
      if (!(await tokenCached(env))) budget.take(1);
      try {
        await timed(() => armToken(env));
      } catch (e) {
        throw new SignInFailed(e instanceof FetchTimeout ? "no answer in 8 s" : plainError(e));
      }
    })());

  for (const f of feeds) {
    const ctx = makeCtx(env, now, snap, cfg, budget, signIn);
    if (!whenHolds(f.when, snap, now.getTime())) continue;
    // Read fresh: an earlier feed may have made this one due (metric names after a refused metrics call).
    const row = (await readFeedRows(env.DB)).get(f.id) ?? null;
    if (!(await isDue(f, row, ctx))) continue;

    let result: FeedResult;
    if (f.calls > budget.remaining()) {
      result = { status: "skipped", error: `This run's ${AZ_RUN_BUDGET} Azure calls were used up; it runs next time.` };
    } else {
      try {
        if (f.arm) await signIn();
        result = await f.run(ctx);
      } catch (e) {
        if (e instanceof BudgetExceeded) result = { status: "skipped", error: `This run's ${AZ_RUN_BUDGET} Azure calls were used up; it runs next time.` };
        else result = { status: "error", error: plainError(e) };
      }
    }
    if (result.status !== "ok") lines.push(`${f.id} ${result.status}${result.error ? `: ${plainError(result.error)}` : ""}`);
    try {
      await record(env, f.id, now, result, row, f.cadenceMin);
    } catch (e) {
      lines.push(`${f.id}: could not record (${plainError(e)})`);
    }
  }
  return lines;
}

/** The ids the runner knows, for checks. */
export const RUNNER_FEED_IDS: readonly InsightsFeedId[] = [...FEED_IDS, "housekeeping"];
