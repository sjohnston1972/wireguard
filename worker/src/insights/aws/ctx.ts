// insights/aws/ctx.ts
//
// Plain English: what one AWS feed's run is given (AwsFeedCtx in
// aws/types.ts). Every outside call goes through a helper here that, in this
// order: stops once the run is out of time, takes one call from the run's
// budget, gives up after 8 s, and turns AWS's answer into plain words: a
// throttle becomes AwsThrottled (the feed is skipped and stays due), a
// refusal names the permission the Worker's AWS user needs, and nothing
// quotes a URL, a key or a signature. The headend and the tagged resources
// are looked up once per run and shared by every feed of that run, each
// as one request (one page: the headend filter matches one instance, and
// cloudlabs tags far fewer than a page of resources), so one budget unit.

import type { Env, Config } from "../../env";
import { config } from "../../env";
import type { Snapshot } from "../../state";
import { getSnapshot } from "../../state";
import { effectiveConfig } from "../../settings";
import { AwsError, awsJson, awsQuery, ec2 as ec2Call } from "../../cloud/awsApi";
import { findHeadend, taggedArns } from "../../cloud/aws";
import { BudgetExceeded, makeBudget, type Budget } from "../types";
import { FETCH_TIMEOUT_MS, OUT_OF_TIME, withTimeout, type FeedRow } from "../common";
import { awsPlainError, iamPermission, isAwsThrottle } from "./common";
import { AwsThrottled, type AwsFeedCtx, type AwsHeadend } from "./types";

/** Thrown before an outside call once the run is past its soft deadline. Ends the feed as skipped. */
export class AwsOutOfTime extends Error {
  constructor() {
    super(OUT_OF_TIME);
    this.name = "AwsOutOfTime";
  }
}

class AwsFetchTimeout extends Error {
  constructor() {
    super(`An AWS call took longer than ${FETCH_TIMEOUT_MS / 1000} s and was given up.`);
    this.name = "AwsFetchTimeout";
  }
}

/** What one run shares between its feeds: the headend and the tagged ids, each looked up at most once. */
export interface AwsRunShared {
  headend?: Promise<AwsHeadend | null>;
  taggedIds?: Promise<Set<string>>;
}

/** What the runner adds to one feed's ctx. */
export interface AwsRunParts {
  row?: FeedRow | null;
  /** True once the run is past its deadline: no more outside calls. */
  late?(): boolean;
  /** The run's shared lookups; a fresh one (per ctx) when absent. */
  shared?: AwsRunShared;
}

/**
 * The ctx one AWS feed runs with. `run.shared` is passed by the runner so
 * every feed of the run shares one headend lookup and one tagged-ids lookup.
 */
export function makeAwsCtx(env: Env, now: Date, snap: Snapshot, cfg: Config, budget: Budget, run: AwsRunParts = {}): AwsFeedCtx {
  const shared = run.shared ?? {};
  /** One outside call: in time, from the budget, at most 8 s, in plain words. */
  const call = async <T>(make: (signal: AbortSignal) => Promise<T>, action: string, permission: string): Promise<T> => {
    if (run.late?.()) throw new AwsOutOfTime();
    budget.take(1);
    try {
      return await withTimeout(make, () => new AwsFetchTimeout());
    } catch (e) {
      if (e instanceof AwsFetchTimeout || e instanceof BudgetExceeded) throw e;
      if (isAwsThrottle(e)) throw new AwsThrottled(awsPlainError(e, action, permission));
      if (e instanceof AwsError) throw new Error(awsPlainError(e, action, permission));
      // A network failure: its name only, never the URL (or anything signed).
      throw new Error(`A call to AWS failed (${(e as Error)?.name ?? "error"}).`);
    }
  };
  /** Remember a lookup's answer for the run, but not a budget or time stop: a later feed may still have room. */
  const once = <T>(p: Promise<T>, forget: () => void): Promise<T> =>
    p.catch((e) => {
      if (e instanceof BudgetExceeded || e instanceof AwsOutOfTime) forget();
      throw e;
    });
  return {
    env,
    db: env.DB,
    now,
    snap,
    cfg,
    budget,
    region: config(env).aws.region,
    ...("row" in run ? { row: run.row ?? null } : {}),
    ec2(action, params = {}, region) {
      return call(() => ec2Call(env, action, params, region), action, iamPermission("ec2", action));
    },
    query(service, action, params, version) {
      return call(() => awsQuery(env, service, action, params, version), action, iamPermission(service, action));
    },
    json<T>(o: { service: string; region: string; host: string; target: string; body: unknown }) {
      const action = o.target.split(".").pop() ?? o.target;
      return call(() => awsJson<T>(env, o), action, iamPermission(o.service, action));
    },
    fetch(url, init = {}) {
      // Unsigned (the public status RSS): no AWS error codes come back, only a Response or a network failure.
      return call((signal) => fetch(url, { ...init, signal }), "an outside call", "no permission");
    },
    headend() {
      return (shared.headend ??= once(
        call(() => findHeadend(env, 1), "DescribeInstances", iamPermission("ec2", "DescribeInstances")).then((h) => (h ? { id: h.id, state: h.state, launchTime: h.launchTime, instanceType: h.type } : null)),
        () => (shared.headend = undefined),
      ));
    },
    taggedIds() {
      return (shared.taggedIds ??= once(
        call(() => taggedArns(env, 1), "GetResources", iamPermission("tagging", "GetResources")).then((arns) => new Set(arns.map((a) => a.split(/[:/]/).pop() ?? "").filter(Boolean))),
        () => (shared.taggedIds = undefined),
      ));
    },
  };
}

/**
 * A ctx for one on-demand AWS job outside the cron (POST boot log, a
 * capacity cache miss), with its own small budget and the same timeouts and
 * error rules as a feed.
 */
export async function oneOffAwsCtx(env: Env, now: Date, limit: number): Promise<AwsFeedCtx> {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return makeAwsCtx(env, now, snap, cfg, makeBudget(limit));
}
