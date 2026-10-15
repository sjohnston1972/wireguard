// insights/common.ts
//
// Plain English: small helpers every collector feed shares: where the
// headend's resources live in Azure, whether they exist right now, the
// latest-document store (az_latest), and turning any error into plain words
// that never quote a URL (a boot log's URL carries a signature that works
// as a password for five minutes).

import type { Env, Config } from "../env";
import type { Snapshot } from "../state";
import type { FeedCtx, FeedResult } from "./types";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Azure's metric slot, seconds. */
export const SLOT = 300;
export const iso = (ms: number) => new Date(ms).toISOString();

/** The slot start holding `ms`, in hist_vm's "YYYY-MM-DDTHH:MM:SSZ" form. */
export function slotOf(ms: number, res = SLOT): string {
  return new Date(Math.floor(ms / (res * 1000)) * res * 1000).toISOString().replace(".000Z", "Z");
}

/** ARM paths of the headend's resources. */
export function paths(env: Env, cfg: Config) {
  const sub = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}`;
  const rg = `${sub}/resourceGroups/${cfg.resourceGroup}`;
  return {
    sub,
    rg,
    vm: `${rg}/providers/Microsoft.Compute/virtualMachines/vm-wg`,
    pip: `${rg}/providers/Microsoft.Network/publicIPAddresses/pip-wg`,
  };
}

/** States in which the VM itself exists (powered on or deallocated). */
const VM_STATES = new Set<Snapshot["state"]>(["running", "hibernating", "standby", "resuming"]);
/** States after "running" in which the VM still exists, so its last metric slots can still be read. */
const AFTER_RUNNING = new Set<Snapshot["state"]>(["hibernating", "standby", "destroying"]);
/** How long after the VM stops vmMetrics keeps reading (Azure's last slots arrive late). */
export const METRICS_TAIL_MS = 15 * MIN;

/** The resource group exists: anything but Destroyed, or Azure's own inventory says so (a failed run can leave it). */
export function rgExists(snap: Snapshot): boolean {
  if (snap.state === "failed") return snap.azure?.exists === true;
  return snap.state !== "destroyed" || snap.azure?.exists === true;
}

export function vmExists(snap: Snapshot): boolean {
  return VM_STATES.has(snap.state);
}

/** Running, or stopped less than 15 minutes ago with the VM still there. */
export function vmMetricsApply(snap: Snapshot, now: number): boolean {
  if (snap.state === "running") return true;
  if (!AFTER_RUNNING.has(snap.state)) return false;
  const since = Date.parse(snap.since ?? "");
  return Number.isFinite(since) && now - since < METRICS_TAIL_MS;
}

/** Plain words for any error, with no URL in them (signed URLs are secrets), at most 300 characters. */
export function plainError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
  return (
    raw
      .replace(/https?:\/\/[^\s"'<>]*/gi, "‹link›")
      .replace(/[?&]sig=[^\s"'&]*/gi, "‹redacted›")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300) || "Something went wrong."
  );
}

/** A refused ARM call, in plain words with Azure's error code (never the URL or the body). */
export async function armRefusal(what: string, r: Response): Promise<Error> {
  let code = "";
  try {
    const j = (await r.json()) as { error?: { code?: unknown } };
    if (typeof j?.error?.code === "string") code = j.error.code.slice(0, 80);
  } catch {
    /* no body, or not JSON */
  }
  return new Error(`Azure refused ${what} (${r.status}${code ? ` ${code}` : ""}).`);
}

/** An ARM GET that must succeed, as parsed JSON. */
export async function armJson<T>(ctx: FeedCtx, path: string, what: string, init?: RequestInit): Promise<T> {
  const r = await ctx.arm(path, init);
  if (!r.ok) throw await armRefusal(what, r);
  return (await r.json()) as T;
}

// ── az_latest ────────────────────────────────────────────────────────────

export async function getLatest<T>(db: D1Database, key: string): Promise<{ doc: T; updatedAt: string } | null> {
  const r = await db.prepare("SELECT json, updated_at FROM az_latest WHERE key = ?1").bind(key).first<{ json: string; updated_at: string }>();
  if (!r) return null;
  try {
    return { doc: JSON.parse(r.json) as T, updatedAt: r.updated_at };
  } catch {
    return null;
  }
}

export function putLatestStmt(db: D1Database, key: string, doc: unknown, at: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO az_latest (key, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(doc), at);
}

export async function putLatest(db: D1Database, key: string, doc: unknown, at: string): Promise<void> {
  await putLatestStmt(db, key, doc, at).run();
}

// ── az_feed ──────────────────────────────────────────────────────────────

export interface FeedRow {
  feed: string;
  last_try_at: string | null;
  last_ok_at: string | null;
  status: string;
  error: string | null;
  next_due_at: string | null;
}

export async function readFeedRows(db: D1Database): Promise<Map<string, FeedRow>> {
  const rows = (await db.prepare("SELECT feed, last_try_at, last_ok_at, status, error, next_due_at FROM az_feed").all<FeedRow>()).results;
  return new Map(rows.map((r) => [r.feed, r]));
}

/**
 * Claim the right to try something at most once per `windowMs` (a capacity
 * cache miss per region, POST boot log), in one step so two requests racing
 * cannot both win. Kept in az_latest under `key`, never in KV.
 */
export async function claimTry(db: D1Database, key: string, now: Date, windowMs: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO az_latest (key, json, updated_at) VALUES (?1, '{}', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at WHERE az_latest.updated_at <= ?3")
    .bind(key, now.toISOString(), iso(now.getTime() - windowMs))
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** The statement that makes a feed due at the next run. */
export function markDueStmt(db: D1Database, feed: string): D1PreparedStatement {
  return db.prepare("INSERT INTO az_feed (feed, status, next_due_at) VALUES (?1, 'idle', NULL) ON CONFLICT (feed) DO UPDATE SET next_due_at = NULL").bind(feed);
}

/**
 * Make a feed due (for example metricDefs after a metrics call refused a
 * name). In a cron run the runner holds it: a later feed in the same run
 * runs, otherwise it is saved with the run's results. Elsewhere, at once.
 */
export async function markDue(ctx: Pick<FeedCtx, "db" | "markDue">, feed: string): Promise<void> {
  if (ctx.markDue) ctx.markDue(feed);
  else await markDueStmt(ctx.db, feed).run();
}

// ── Shared by the Azure runner (runner.ts) and the AWS one (aws/runner.ts) ─

/** Every outside call is given up after this long. */
export const FETCH_TIMEOUT_MS = 8_000;
/** A feed is due a little early, so a cron that fires a few seconds early does not push it back a whole cadence. */
export const DUE_SLACK_MS = 30_000;
export const OUT_OF_TIME = "This run ran out of time; it runs next time.";

/** Due by its row: never run, no next time set, or that time has (nearly) come. */
export function dueByRow(row: Pick<FeedRow, "next_due_at"> | null, now: Date): boolean {
  return !row || !row.next_due_at || Date.parse(row.next_due_at) <= now.getTime() + DUE_SLACK_MS;
}

/** Run `make` with an abort signal that fires after 8 s; the race also ends a call that ignores its signal. */
export async function withTimeout<T>(make: (signal: AbortSignal) => Promise<T>, onTimeout: () => Error): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(onTimeout());
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([make(ac.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The write of one feed's result to its table (az_feed or aws_feed). A skipped feed keeps its next time: it stays due. */
export function feedResultStmt(db: D1Database, table: "az_feed" | "aws_feed", id: string, now: Date, r: FeedResult, row: FeedRow | null, cadenceMin: number | null): D1PreparedStatement {
  const at = now.toISOString();
  let next: string | null;
  if (r.status === "skipped") next = row?.next_due_at ?? null; // stays due
  else if (r.nextDueAt) next = r.nextDueAt;
  else next = cadenceMin === null ? null : iso(now.getTime() + cadenceMin * MIN);
  return db
    .prepare(
      `INSERT INTO ${table} (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (feed) DO UPDATE SET last_try_at = excluded.last_try_at, last_ok_at = COALESCE(excluded.last_ok_at, ${table}.last_ok_at),
       status = excluded.status, error = excluded.error, next_due_at = excluded.next_due_at`,
    )
    .bind(id, at, r.status === "ok" ? at : null, r.status, r.error === null ? null : plainError(r.error), next);
}

/**
 * Write a run's results in one batch. If the batch fails (all or nothing),
 * each statement is tried on its own, so one bad write never loses the rest.
 */
export async function flushResults(db: D1Database, stmts: { id: string; stmt: D1PreparedStatement }[], lines: string[]): Promise<void> {
  if (!stmts.length) return;
  try {
    await db.batch(stmts.map((s) => s.stmt));
    return;
  } catch {
    // fall through: one at a time
  }
  for (const { id, stmt } of stmts) {
    try {
      await stmt.run();
    } catch (e) {
      lines.push(`${id}: could not record (${plainError(e)})`);
    }
  }
}

// ── Small parsing helpers (everything parsed is trimmed and capped) ───────

/** A string, trimmed and capped, or null. */
export function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** A finite number, or null. */
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** An ISO time from Azure, normalised to toISOString, or null. */
export function time(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Azure's `{ value, localizedValue }` pairs, or a plain string. */
export function valueOf(v: unknown, max = 200): string | null {
  if (v && typeof v === "object") return str((v as { value?: unknown }).value, max);
  return str(v, max);
}
