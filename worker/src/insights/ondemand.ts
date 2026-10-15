// insights/ondemand.ts
//
// Plain English: the two things a page can make the Worker ask Azure for
// outside the cron, each in its own request with its own small budget:
//   - a capacity check for a region with no fresh reading (at most one try
//     per region per 10 minutes, 3 calls: sign-in, sizes, usages),
//   - "Fetch now" on the boot log (insights/feeds/bootLog.ts, at most once a
//     minute).
// Pages otherwise read D1 only.
//
// With the server in AWS (AWS insights spec section 6) the same two go to AWS
// instead: "Fetch now" through the AWS boot log feed's fetchAwsBootLogNow,
// and a capacity cache miss for AWS's own region through one run of the AWS
// capacity feed (4 calls), under the same once-per-10-minutes rule.

import type { Env, Config } from "../env";
import { config } from "../env";
import type { CapacityCheck } from "../../../shared/api";
import { REGIONS } from "../region";
import { getSnapshot } from "../state";
import { insightsConfigured, type BootLogDoc, type HealthDoc } from "./types";
import { claimTry, getLatest, iso, MIN, plainError, vmExists } from "./common";
import { oneOffCtx, recordFeedResult } from "./runner";
import { NEXT_DEPLOY, NO_VM, fetchAndStoreBootLog } from "./feeds/bootLog";
import { CAPACITY_FRESH_MS, capacityCheck, emptyCheck, fetchCapacity, readCapacity, sizesOfInterest, storeCapacity } from "./feeds/capacity";
import { awsConfigured } from "./aws/types";
import { awsPlainError } from "./aws/common";
import { oneOffAwsCtx } from "./aws/ctx";
import { recordAwsFeedResult } from "./aws/runner";
import { asBootLogResponse, readAwsCapacity } from "./aws/read";
import { fetchAwsBootLogNow } from "./aws/feeds/bootLog";
import awsCapacityFeed, { awsCapacityCheck, awsCapacitySizes } from "./aws/feeds/capacity";

/** One try per region per this long on a cache miss. */
export const CAPACITY_RETRY_MS = 10 * MIN;
/** Sign-in, the size list and the usages. */
const CAPACITY_CALLS = 3;

/**
 * The capacity check for a region and size. From the stored reading when it
 * is under a day old; otherwise, for an offered region with Azure connected,
 * read it now (once per region per 10 minutes). When that is not possible,
 * an older reading if there is one, else "not known" (ok null).
 */
export async function capacityFor(env: Env, cfg: Config, region: string, size: string, now: Date): Promise<CapacityCheck> {
  const have = await readCapacity(env.DB, region);
  const fresh = have && now.getTime() - Date.parse(have.fetchedAt) < CAPACITY_FRESH_MS;
  const fromHave = () => (have ? capacityCheck(have.doc, region, size, cfg.testVm, have.fetchedAt, now) : emptyCheck(region, size));
  if (fresh && have.doc.sizes.some((s) => s.name === size)) return fromHave();
  if (!insightsConfigured(env) || !Object.hasOwn(REGIONS, region)) return fromHave();
  if (!(await claimTry(env.DB, `capacity-try:${region}`, now, CAPACITY_RETRY_MS))) return fromHave();
  try {
    const ctx = await oneOffCtx(env, now, CAPACITY_CALLS);
    const doc = await fetchCapacity(ctx, region, await sizesOfInterest(ctx, [size]));
    const at = now.toISOString();
    await storeCapacity(env.DB, region, doc, at);
    return capacityCheck(doc, region, size, cfg.testVm, at, now);
  } catch (e) {
    console.error("capacity check failed:", e instanceof Error ? e.name : "error");
    return fromHave();
  }
}

/** POST boot log: at most once per this long (whoever asked, the cron included through its own once-per-episode rule). */
export const BOOTLOG_RETRY_MS = 60_000;
/** Sign-in, the signed link, HEAD and the ranged GET. */
const BOOTLOG_CALLS = 4;

export type BootLogNow = { ok: true; doc: BootLogDoc } | { ok: false; why: "slow_down" } | { ok: false; why: "upstream"; message: string };

/** "Fetch now": the boot log, fetched, redacted and stored; limited to one a minute. Errors in plain words, never a URL. */
export async function fetchBootLogNow(env: Env, now: Date): Promise<BootLogNow> {
  if (!(await claimTry(env.DB, "bootlog-try", now, BOOTLOG_RETRY_MS))) return { ok: false, why: "slow_down" };
  try {
    const ctx = await oneOffCtx(env, now, BOOTLOG_CALLS);
    const doc = await fetchAndStoreBootLog(ctx);
    if (doc.reason !== NO_VM) await recordFeedResult(env, "bootLog", now, { status: "ok", error: null });
    return { ok: true, doc };
  } catch (e) {
    const message = plainError(e);
    await recordFeedResult(env, "bootLog", now, { status: "error", error: message }).catch(() => {});
    return { ok: false, why: "upstream", message };
  }
}

/** GET boot log: the stored one, or why there is none. */
export async function storedBootLog(env: Env, notConnected: string, notFetched: string): Promise<BootLogDoc> {
  const have = await getLatest<BootLogDoc>(env.DB, "bootlog");
  if (have?.doc && typeof have.doc === "object") return have.doc;
  const none = (reason: string): BootLogDoc => ({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason });
  if (!insightsConfigured(env)) return none(notConnected);
  if (!vmExists(await getSnapshot(env))) return none(NO_VM);
  const health = await getLatest<HealthDoc>(env.DB, "health");
  if (health?.doc?.bootDiagnostics === false) return none(NEXT_DEPLOY);
  return none(notFetched);
}

/** The deploy form's current target, from the stored reading only (never a fetch); null until one exists. */
export async function deployTargetCapacity(env: Env, cfg: Config, now: Date): Promise<CapacityCheck | null> {
  const have = await readCapacity(env.DB, cfg.region);
  return have ? capacityCheck(have.doc, cfg.region, cfg.vmSize, cfg.testVm, have.fetchedAt, now) : null;
}

// ── AWS ──────────────────────────────────────────────────────────────────

/** The same once-per-window claim as claimTry, kept in aws_latest beside the AWS feeds' other markers. */
async function claimAwsTry(db: D1Database, key: string, now: Date, windowMs: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES (?1, '{}', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at WHERE aws_latest.updated_at <= ?3")
    .bind(key, now.toISOString(), iso(now.getTime() - windowMs))
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/**
 * The AWS capacity check for a region and instance type (GET
 * /api/v1/azure/capacity with an AWS region). From the stored reading when
 * it is under a day old and has the type; otherwise, for AWS's own region
 * with AWS connected and a type the feed reads (awsCapacitySizes), one run
 * of the AWS capacity feed now (once per region per 10 minutes). When that is not possible, an older reading if there is
 * one, else "not known" (awsCapacityCheck with no doc).
 */
export async function awsCapacityFor(env: Env, cfg: Config, region: string, size: string, now: Date): Promise<CapacityCheck> {
  let have = await readAwsCapacity(env.DB, region);
  const fromHave = () => awsCapacityCheck(have?.doc ?? null, region, size, cfg.testVm, have?.fetchedAt ?? null);
  const fresh = have && now.getTime() - Date.parse(have.fetchedAt) < CAPACITY_FRESH_MS;
  if (fresh && have!.doc.sizes.some((s) => s.name === size)) return fromHave();
  // The feed reads AWS's configured region and its two instance types only: for anything else a fetch could not help.
  if (!awsConfigured(env) || region !== config(env).aws.region || !awsCapacitySizes(cfg).includes(size)) return fromHave();
  if (!(await claimAwsTry(env.DB, `capacity-try:${region}`, now, CAPACITY_RETRY_MS))) return fromHave();
  try {
    const ctx = await oneOffAwsCtx(env, now, awsCapacityFeed.calls);
    const r = await awsCapacityFeed.run(ctx);
    await recordAwsFeedResult(env, awsCapacityFeed.id, now, r, awsCapacityFeed.cadenceMin);
    have = (await readAwsCapacity(env.DB, region)) ?? have;
  } catch (e) {
    console.error("AWS capacity check failed:", awsPlainError(e));
  }
  return fromHave();
}

/** The deploy form's AWS target (AWS's region and instance type), from the stored reading only (never a fetch); null until one exists. */
export async function awsDeployTargetCapacity(env: Env, cfg: Config): Promise<CapacityCheck | null> {
  const have = await readAwsCapacity(env.DB, cfg.aws.region);
  return have ? awsCapacityCheck(have.doc, cfg.aws.region, cfg.aws.instanceType, cfg.testVm, have.fetchedAt) : null;
}

/**
 * "Fetch now" with the server in AWS: AWS's boot log feed fetches, redacts
 * and stores the console output (one a minute, its own rule). Answered in
 * BootLogNow's shape so the route treats both clouds alike; errors in plain
 * words, never a URL.
 */
export async function awsBootLogNow(env: Env, now: Date): Promise<BootLogNow> {
  try {
    const r = await fetchAwsBootLogNow(env, now);
    if (r.ok) return { ok: true, doc: asBootLogResponse(r.doc) };
    if (r.why === "slow_down") return { ok: false, why: "slow_down" };
    return { ok: false, why: "upstream", message: r.message };
  } catch (e) {
    return { ok: false, why: "upstream", message: awsPlainError(e) };
  }
}
