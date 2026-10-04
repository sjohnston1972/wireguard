// insights/common.ts
//
// Plain English: small helpers every collector feed shares: where the
// headend's resources live in Azure, whether they exist right now, the
// latest-document store (az_latest), and turning any error into plain words
// that never quote a URL (a boot log's URL carries a signature that works
// as a password for five minutes).

import type { Env, Config } from "../env";
import type { Snapshot } from "../state";
import type { FeedCtx } from "./types";

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

/** Make a feed due at the next run (for example metricDefs after a metrics call refused a name). */
export async function markDue(db: D1Database, feed: string): Promise<void> {
  await db.prepare("INSERT INTO az_feed (feed, status, next_due_at) VALUES (?1, 'idle', NULL) ON CONFLICT (feed) DO UPDATE SET next_due_at = NULL").bind(feed).run();
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
