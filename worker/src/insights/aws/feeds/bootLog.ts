// insights/aws/feeds/bootLog.ts
//
// Plain English: the headend's console output ("boot log"), for when the
// server stops answering. One EC2 GetConsoleOutput call (Latest=true: the
// newest output, not only the first boot's) answers the text as base64; it
// becomes text, keeps its last 64 KB (from a whole line), and is redacted
// with insights/redact.ts, the run's SSH password and tokens included, as
// on Azure, before it is stored as aws_latest['bootlog'] with the launch
// time it was read for.
//
// When it is read:
//   - by the cron, once after each start: due when the headend's launch time
//     differs from the stored log's (or nothing was read yet). A start that
//     has no output yet (AWS needs a few minutes), or a read that failed, is
//     tried again every 10 minutes for the first hour after the start;
//   - on demand by POST /api/v1/azure/bootlog when the server is in AWS
//     (fetchAwsBootLogNow), at most once a minute, with its own budget of 2
//     calls (the headend lookup and the read).
// Never while AWS is not configured. Errors never quote AWS's message.
// Spec 2026-10-15-aws-insights-design.md, section 4.7.

import type { Env } from "../../../env";
import type { BootLogResponse } from "../../../../../shared/api";
import { xmlFirst } from "../../../cloud/awsApi";
import { currentDeployment } from "../../../db";
import { HOUR, MIN, iso } from "../../common";
import { redact } from "../../redact";
import { BOOTLOG_MAX_BYTES, NO_VM, tokensByHash } from "../../feeds/bootLog";
import { BudgetExceeded, type FeedResult } from "../../types";
import { awsPlainError, getAwsLatest, putAwsLatest } from "../common";
import { AwsOutOfTime, oneOffAwsCtx } from "../ctx";
import { recordAwsFeedResult } from "../runner";
import { AwsThrottled, awsConfigured, type AwsBootLogDoc, type AwsFeed, type AwsFeedCtx } from "../types";

export const AWS_NO_OUTPUT = "AWS has no console output for this server yet.";
/** POST boot log: at most once per this long. */
export const AWS_BOOTLOG_RETRY_MS = 60_000;
/** A start whose log could not be read yet is tried again this often ... */
const RETRY_MS = 10 * MIN;
/** ... for this long after the start. */
const RETRY_FOR_MS = HOUR;
/** The headend lookup and GetConsoleOutput. */
const BOOTLOG_CALLS = 2;

/** GetConsoleOutput for the headend, the newest output. The XML. */
export async function fetchAwsBootLog(ctx: AwsFeedCtx, instanceId: string): Promise<string> {
  return ctx.ec2("GetConsoleOutput", { InstanceId: instanceId, Latest: "true" });
}

/** base64 to bytes (whitespace ignored); null when it is not base64. */
function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * GetConsoleOutput's answer as the stored boot log: the last 64 KB as text,
 * redacted. `extraSecrets` are literal secrets (the SSH password);
 * `tokenHashes` are SHA-256 hashes of tokens whose literals are redacted
 * wherever they appear. No output yet: a reason instead.
 */
export async function normaliseAwsBootLog(xml: string, now: Date, launchTime: string | null, extraSecrets: (string | null)[] = [], tokenHashes: (string | null)[] = []): Promise<AwsBootLogDoc> {
  const all = fromBase64(xmlFirst(xml, "output") ?? "");
  if (!all || all.length === 0) return { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: AWS_NO_OUTPUT, launchTime };
  const truncated = all.length > BOOTLOG_MAX_BYTES;
  const bytes = all.slice(-BOOTLOG_MAX_BYTES);
  let text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  if (truncated) {
    // The tail starts mid-line: drop the partial first line.
    const nl = text.indexOf("\n");
    if (nl >= 0 && nl < 4096) text = text.slice(nl + 1);
  }
  const clean = redact(text, [...extraSecrets, ...(await tokensByHash(text, tokenHashes))]);
  return { fetchedAt: now.toISOString(), bytes: bytes.length, truncated, redactions: clean.count, text: clean.text.slice(-BOOTLOG_MAX_BYTES), reason: null, launchTime };
}

export async function storeAwsBootLog(db: D1Database, doc: AwsBootLogDoc, now: Date): Promise<void> {
  await putAwsLatest(db, "bootlog", doc, now.toISOString());
}

/** The token hashes of the server's run: the current deployment's, and the newest apply run's (one may still be finishing). */
async function runSecrets(env: Env): Promise<{ secrets: (string | null)[]; hashes: (string | null)[] }> {
  const dep = await currentDeployment(env).catch(() => null);
  const newest = await env.DB.prepare("SELECT callback_token_hash, agent_token_hash FROM runs WHERE action = 'apply' ORDER BY requested_at DESC LIMIT 1")
    .first<{ callback_token_hash: string | null; agent_token_hash: string | null }>()
    .catch(() => null);
  return {
    secrets: [dep?.ssh_password ?? null],
    hashes: [dep?.agent_token_hash ?? null, dep?.callback_token_hash ?? null, newest?.agent_token_hash ?? null, newest?.callback_token_hash ?? null],
  };
}

/** Read, redact and store the headend's boot log; "No VM" (not stored) when there is no headend. */
export async function fetchAndStoreAwsBootLog(ctx: AwsFeedCtx): Promise<AwsBootLogDoc> {
  const h = await ctx.headend();
  if (!h) return { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: NO_VM, launchTime: null };
  const xml = await fetchAwsBootLog(ctx, h.id);
  const { secrets, hashes } = await runSecrets(ctx.env);
  const doc = await normaliseAwsBootLog(xml, ctx.now, h.launchTime, secrets, hashes);
  await storeAwsBootLog(ctx.db, doc, ctx.now);
  return doc;
}

/** One claim per window on aws_latest[key]: true when this caller may go ahead. */
async function claimAwsTry(db: D1Database, key: string, now: Date, windowMs: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES (?1, '{}', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at WHERE aws_latest.updated_at <= ?3")
    .bind(key, now.toISOString(), iso(now.getTime() - windowMs))
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/**
 * Fetch the boot log now for POST /api/v1/azure/bootlog (its own budget of 2
 * calls), the same shape as Azure's fetchBootLogNow (insights/ondemand.ts):
 * the stored doc, or why not ("slow_down": one a minute, or AWS asked to
 * slow down; "error": in plain words, never a URL or AWS's own message).
 */
export async function fetchAwsBootLogNow(env: Env, now: Date): Promise<{ ok: true; doc: BootLogResponse } | { ok: false; why: "slow_down" | "error"; message: string }> {
  if (!awsConfigured(env)) return { ok: false, why: "error", message: "AWS isn't connected. Add the Worker's AWS keys." };
  if (!(await claimAwsTry(env.DB, "bootlog-try", now, AWS_BOOTLOG_RETRY_MS))) {
    return { ok: false, why: "slow_down", message: "The boot log was fetched less than a minute ago. Try again in a minute." };
  }
  try {
    const ctx = await oneOffAwsCtx(env, now, BOOTLOG_CALLS);
    const doc = await fetchAndStoreAwsBootLog(ctx);
    if (doc.reason !== NO_VM) await recordAwsFeedResult(env, "aws.bootLog", now, { status: "ok", error: null });
    // The page gets Azure's shape: the launch time is the cron's bookkeeping.
    return { ok: true, doc: { fetchedAt: doc.fetchedAt, bytes: doc.bytes, truncated: doc.truncated, redactions: doc.redactions, text: doc.text, reason: doc.reason } };
  } catch (e) {
    if (e instanceof AwsThrottled) return { ok: false, why: "slow_down", message: e.message };
    const message = e instanceof BudgetExceeded || e instanceof AwsOutOfTime ? "The boot log could not be fetched in time; try again in a minute." : awsPlainError(e);
    const r: FeedResult = { status: "error", error: message };
    await recordAwsFeedResult(env, "aws.bootLog", now, r).catch(() => {});
    return { ok: false, why: "error", message };
  }
}

/**
 * Due once after each start: the headend's launch time differs from the
 * stored log's (or nothing was read yet). A start that has no log yet (no
 * output, or the read failed) is tried again every 10 minutes for the first
 * hour after it. Uses the run's shared headend lookup.
 */
export async function awsBootLogDue(ctx: AwsFeedCtx, row: { last_try_at: string | null } | null): Promise<boolean> {
  const h = await ctx.headend();
  const launched = Date.parse(h?.launchTime ?? "");
  if (!h || !Number.isFinite(launched)) return false;
  const doc = (await getAwsLatest<AwsBootLogDoc>(ctx.db, "bootlog"))?.doc;
  const forThisStart = doc && typeof doc === "object" && doc.launchTime === h.launchTime;
  if (forThisStart && doc.text !== null) return false;
  const tried = Date.parse(row?.last_try_at ?? "");
  if (!Number.isFinite(tried) || tried < launched) return true; // not tried since this start
  const now = ctx.now.getTime();
  return now - launched < RETRY_FOR_MS && now - tried >= RETRY_MS;
}

const bootLog: AwsFeed = {
  id: "aws.bootLog",
  title: "Boot log",
  cadenceMin: null,
  when: "server",
  calls: 1,
  due: awsBootLogDue,
  async run(ctx) {
    await fetchAndStoreAwsBootLog(ctx);
    return { status: "ok", error: null };
  },
};

export default bootLog;
