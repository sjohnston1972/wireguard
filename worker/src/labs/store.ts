// labs/store.ts
//
// Plain English: the lab engine's only SQL (migration 0020: lab_sessions,
// lab_runs, lab_slots, lab_cost_days, lab_release_tests). Everything else
// asks for "this lab's live session" or "this run" and gets typed rows back.
//
// D1 binds every JS number as REAL, so integer columns (slot, test,
// lab_version, github_run_id) are always bound with CAST(? AS INTEGER).
// Conditional updates ("only if the run has not finished") are one
// statement each, so two callers racing cannot both win.

import type { Env } from "../env";
import { LAB_LIVE_STATES } from "../../../shared/labs";

export interface LabSessionRow {
  id: string;
  lab_id: string;
  lab_version: number;
  state: string;
  test: number;
  region: string;
  secondary_region: string | null;
  slot: number | null;
  cidr: string | null;
  name_prefix: string;
  peering: string;
  requested_at: string;
  ready_at: string | null;
  ended_at: string | null;
  auto_destroy_at: string | null;
  max_until: string;
  warned_at: string | null;
  est_gbp_h: number;
  est_gbp: number | null;
  end_reason: string | null;
  outputs_json: string | null;
  leftovers_json: string | null;
  note: string | null;
}

export interface LabRunDb {
  id: string;
  session_id: string;
  lab_id: string;
  action: string;
  status: string;
  requested_at: string;
  requested_by: string | null;
  reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  github_run_id: number | null;
  github_run_url: string | null;
  callback_token_hash: string | null;
  admin_password: string | null;
  payload_json: string | null;
  outputs_json: string | null;
  steps_json: string | null;
  error: string | null;
}

/** Live states as an SQL list ('deploying', 'running', ...), from the shared constant. */
export const LIVE_SQL = LAB_LIVE_STATES.map((s) => `'${s}'`).join(", ");
/** A run that has not finished. */
export const ACTIVE_RUN_SQL = "status IN ('queued', 'running') AND finished_at IS NULL";

const INT_COLUMNS = new Set(["slot", "test", "lab_version", "github_run_id"]);

/** "a = ?2, b = CAST(?3 AS INTEGER)" and the values, for a patch. */
function sets(patch: Record<string, unknown>, from = 2): { sql: string; vals: unknown[] } {
  const keys = Object.keys(patch).filter((k) => k !== "id");
  return {
    sql: keys.map((k, i) => (INT_COLUMNS.has(k) ? `${k} = CAST(?${i + from} AS INTEGER)` : `${k} = ?${i + from}`)).join(", "),
    vals: keys.map((k) => patch[k] ?? null),
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────

export async function getSession(env: Env, id: string): Promise<LabSessionRow | null> {
  return (await env.DB.prepare("SELECT * FROM lab_sessions WHERE id = ?1").bind(id).first<LabSessionRow>()) ?? null;
}

/** The lab's live session (deploying, running, failed, tearing_down), newest first; null with none. */
export async function liveSessionOf(env: Env, labId: string): Promise<LabSessionRow | null> {
  return (await env.DB.prepare(`SELECT * FROM lab_sessions WHERE lab_id = ?1 AND state IN (${LIVE_SQL}) ORDER BY requested_at DESC LIMIT 1`).bind(labId).first<LabSessionRow>()) ?? null;
}

/** Every live session, oldest first. */
export async function liveSessions(env: Env): Promise<LabSessionRow[]> {
  return (await env.DB.prepare(`SELECT * FROM lab_sessions WHERE state IN (${LIVE_SQL}) ORDER BY requested_at ASC`).all<LabSessionRow>()).results;
}

export async function insertSession(env: Env, s: LabSessionRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lab_sessions (id, lab_id, lab_version, state, test, region, secondary_region, slot, cidr, name_prefix, peering, requested_at, ready_at, ended_at, auto_destroy_at, max_until, warned_at, est_gbp_h, est_gbp, end_reason, outputs_json, leftovers_json, note)
     VALUES (?1, ?2, CAST(?3 AS INTEGER), ?4, CAST(?5 AS INTEGER), ?6, ?7, CAST(?8 AS INTEGER), ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
  )
    .bind(s.id, s.lab_id, s.lab_version, s.state, s.test, s.region, s.secondary_region, s.slot, s.cidr, s.name_prefix, s.peering, s.requested_at, s.ready_at, s.ended_at, s.auto_destroy_at, s.max_until, s.warned_at, s.est_gbp_h, s.est_gbp, s.end_reason, s.outputs_json, s.leftovers_json, s.note)
    .run();
}

/** Change a session; with `when` (fixed SQL from this engine, never input) only if it still holds. True when a row changed. */
export async function updateSession(env: Env, id: string, patch: Partial<LabSessionRow>, when?: string): Promise<boolean> {
  const { sql, vals } = sets(patch as Record<string, unknown>);
  if (!sql) return false;
  const r = await env.DB.prepare(`UPDATE lab_sessions SET ${sql} WHERE id = ?1${when ? ` AND ${when}` : ""}`).bind(id, ...vals).run();
  return (r.meta?.changes ?? 0) === 1;
}

// ── Slots ────────────────────────────────────────────────────────────────

/**
 * Take the lowest free slot for a session, in one statement (spec §7.1), and
 * only while fewer than `maxRunning` slots are held by sessions that are not
 * ended_dirty (those keep their slot until a clean sweep but are not running).
 * Null when the pool is full or the limit is reached.
 */
export async function reserveSlot(env: Env, sid: string, at: string, maxRunning: number): Promise<{ slot: number; cidr: string } | null> {
  return (
    (await env.DB.prepare(
      `UPDATE lab_slots SET session_id = ?1, since = ?2
       WHERE slot = (SELECT MIN(slot) FROM lab_slots WHERE session_id IS NULL) AND session_id IS NULL
         AND (SELECT COUNT(*) FROM lab_slots h WHERE h.session_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM lab_sessions x WHERE x.id = h.session_id AND x.state IN ('ended', 'ended_dirty'))) < CAST(?3 AS INTEGER)
       RETURNING slot, cidr`,
    )
      .bind(sid, at, maxRunning)
      .first<{ slot: number; cidr: string }>()) ?? null
  );
}

/** Give a session's slot back to the pool. */
export async function freeSlot(env: Env, sid: string): Promise<void> {
  await env.DB.prepare("UPDATE lab_slots SET session_id = NULL, since = NULL WHERE session_id = ?1").bind(sid).run();
}

/** Free slots and the pool's size. */
export async function slotsInUse(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL").first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Sessions holding a slot that are not ended_dirty: the ones labs_max_running counts. */
export async function runningCount(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM lab_sessions WHERE state IN (${LIVE_SQL})`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// ── Runs ─────────────────────────────────────────────────────────────────

export async function getLabRun(env: Env, id: string): Promise<LabRunDb | null> {
  return (await env.DB.prepare("SELECT * FROM lab_runs WHERE id = ?1").bind(id).first<LabRunDb>()) ?? null;
}

/** The session's run in progress, if any. */
export async function activeRunOf(env: Env, sid: string): Promise<LabRunDb | null> {
  return (await env.DB.prepare(`SELECT * FROM lab_runs WHERE session_id = ?1 AND ${ACTIVE_RUN_SQL} ORDER BY requested_at DESC LIMIT 1`).bind(sid).first<LabRunDb>()) ?? null;
}

/** Every run in progress, oldest first. */
export async function activeRuns(env: Env): Promise<LabRunDb[]> {
  return (await env.DB.prepare(`SELECT * FROM lab_runs WHERE ${ACTIVE_RUN_SQL} ORDER BY requested_at ASC`).all<LabRunDb>()).results;
}

/** A session's runs, newest first. */
export async function runsOf(env: Env, sid: string): Promise<LabRunDb[]> {
  return (await env.DB.prepare("SELECT * FROM lab_runs WHERE session_id = ?1 ORDER BY requested_at DESC").bind(sid).all<LabRunDb>()).results;
}

export async function insertRun(env: Env, r: Pick<LabRunDb, "id" | "session_id" | "lab_id" | "action" | "status" | "requested_at" | "requested_by" | "reason" | "admin_password" | "payload_json">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lab_runs (id, session_id, lab_id, action, status, requested_at, requested_by, reason, admin_password, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(r.id, r.session_id, r.lab_id, r.action, r.status, r.requested_at, r.requested_by, r.reason, r.admin_password, r.payload_json)
    .run();
}

export async function updateRun(env: Env, id: string, patch: Partial<LabRunDb>, when?: string): Promise<boolean> {
  const { sql, vals } = sets(patch as Record<string, unknown>);
  if (!sql) return false;
  const r = await env.DB.prepare(`UPDATE lab_runs SET ${sql} WHERE id = ?1${when ? ` AND ${when}` : ""}`).bind(id, ...vals).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Close a run (succeeded, failed, cancelled). False if something else already closed it. */
export function settleRun(env: Env, id: string, patch: Partial<LabRunDb>): Promise<boolean> {
  return updateRun(env, id, patch, "finished_at IS NULL");
}

/** Forget every admin password of a session's runs (the session has ended: they open nothing now). */
export async function clearPasswords(env: Env, sid: string): Promise<void> {
  await env.DB.prepare("UPDATE lab_runs SET admin_password = NULL WHERE session_id = ?1 AND admin_password IS NOT NULL").bind(sid).run();
}

/** A run's parsed private payload ({} when unreadable). */
export function payloadOf(run: Pick<LabRunDb, "payload_json"> | null): Record<string, unknown> {
  try {
    const v = JSON.parse(run?.payload_json ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
