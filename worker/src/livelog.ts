// livelog.ts
//
// Plain English: a run's live log. GitHub only hands out a job's log once
// the job has finished, so the workflow sends its own output here while it
// runs (infra/ci/live-log.mjs posts to /api/callback/log every few seconds).
// The dashboard reads it through GET /api/v1/runs/:id/log until the run has
// finished, then switches to GitHub's full log (api/activity.ts).
//
// The door is the same as the result callback's: the run's callback token,
// and only while that run is still going. Each piece carries a number from
// the workflow, so a piece resent after a network blip is stored once. The
// runner hides every secret before sending; as a second line of defence the
// Worker hides the run secrets it knows too (the SSH password while it is
// still kept, and the callback token itself) before anything is stored.

import type { Env } from "./env";
import * as db from "./db";
import { sha256Hex, safeEqual } from "./auth";
import { refreshLabSteps } from "./labs/refresh";

/** Largest piece accepted, in bytes of UTF-8 (the workflow sends at most 48 KB). */
export const LIVE_LOG_MAX_TEXT = 64 * 1024;
/** Most of one run's live log kept: the newest pieces, about this many bytes. */
export const LIVE_LOG_KEEP_BYTES = 400 * 1024;
/** Days after a run ends that its live log is kept (GitHub keeps the full log far longer). */
export const LIVE_LOG_KEEP_DAYS = 14;
/** A request body bigger than this is refused before it is read (a 64 KB piece is far smaller, even escaped). */
export const LIVE_LOG_MAX_BODY = 512 * 1024;

/** A run that has not finished: the only kind that may still add to its live log. */
export function isActiveRun(run: Pick<db.Run, "status" | "finished_at">): boolean {
  return !run.finished_at && (run.status === "queued" || run.status === "running");
}

const uEscape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
/** < > & and the two JavaScript line separators, which Go's JSON (so Terraform's) writes as \u escapes. */
const GO_ESCAPED = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * A secret inside a URL (encodeURIComponent) or a JSON string: JSON's own
 * escapes, plus the \u escapes other writers add for non-ASCII characters
 * (Python's default) and for < > & (Go's). Same as the runner's.
 */
function escapedForms(v: string): string[] {
  const json = JSON.stringify(v).slice(1, -1);
  const ascii = (s: string) => s.replace(/[^\x00-\x7e]/g, uEscape);
  const html = (s: string) => s.replace(GO_ESCAPED, uEscape);
  return [encodeURIComponent(v), json, ascii(json), html(json), ascii(html(json))];
}

/**
 * The forms a secret can appear in: as typed, URL-encoded and JSON-escaped,
 * base64 on its own, and the part of its base64 that is the same at each of
 * the three byte alignments inside a longer base64 blob. The same rule as the
 * runner's (infra/ci/live-log.mjs).
 */
export function secretForms(value: string): string[] {
  if (value.length < 4) return [];
  const bytes = new TextEncoder().encode(value);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const forms = new Set([value, ...escapedForms(value), b64(bytes)]);
  for (const skip of [0, 1, 2]) {
    const rest = bytes.subarray(skip);
    const enc = b64(rest.subarray(0, Math.floor(rest.length / 3) * 3));
    if (enc.length >= 8) forms.add(enc);
  }
  return [...forms];
}

/** Replace every form of every secret with ***, longest first. */
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  const forms = [...new Set(secrets.filter((s): s is string => !!s).flatMap(secretForms))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms) if (out.includes(f)) out = out.split(f).join("***");
  return out;
}

export interface LiveLogBody {
  run_id?: unknown;
  seq?: unknown;
  text?: unknown;
}

/**
 * One piece of a run's live log from the workflow. Statuses: 401 wrong or
 * missing token, 400 malformed, 404 unknown run (or one with no token yet),
 * 409 the run has finished, 413 too big. A resent piece is a 200 with
 * duplicate: true, and is not stored again.
 */
export async function receiveLiveLog(env: Env, token: string, body: LiveLogBody | null, now = new Date()): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!token) return { status: 401, body: { error: "no token" } };
  const seq = body?.seq;
  if (!body || typeof body.run_id !== "string" || !body.run_id || typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 1_000_000 || typeof body.text !== "string") {
    return { status: 400, body: { error: "expected {run_id, seq, text}" } };
  }
  // A lab run (labs spec §7.1: "lab-<action>-..." in lab_runs) proves itself the same way; its secret is the admin password.
  const run = body.run_id.startsWith("lab-") ? await labRunForLog(env, body.run_id) : await db.getRun(env, body.run_id);
  if (!run || !run.callback_token_hash) return { status: 404, body: { error: "unknown run" } };
  if (!safeEqual(await sha256Hex(token), run.callback_token_hash)) return { status: 401, body: { error: "bad token" } };
  if (!isActiveRun(run as Pick<db.Run, "status" | "finished_at">)) return { status: 409, body: { error: "run is not active" } };
  if (new TextEncoder().encode(body.text).length > LIVE_LOG_MAX_TEXT) return { status: 413, body: { error: "piece too big" } };

  const text = redact(body.text, [run.ssh_password, token]);
  const stored = await db.addLiveLogChunk(env, run.id, seq, now.toISOString(), text);
  if (stored) await db.trimLiveLog(env, run.id, LIVE_LOG_KEEP_BYTES);
  // A lab run's step list ("Deploying 3/11") is read from GitHub here, every fourth piece
  // (about every 20 seconds), so pages never have to ask GitHub themselves. Never fails the piece.
  if (stored && run.id.startsWith("lab-") && seq % 4 === 0) await refreshLabSteps(env, run.id).catch((e) => console.error("lab steps:", e));
  return { status: 200, body: { message: stored ? "ok" : "already stored", duplicate: !stored } };
}

/** A lab run as the live log needs it: its token hash, whether it is going, and its secret (the admin password) to hide. */
async function labRunForLog(env: Env, id: string): Promise<{ id: string; status: string; finished_at: string | null; callback_token_hash: string | null; ssh_password: string | null } | null> {
  return (
    (await env.DB.prepare("SELECT id, status, finished_at, callback_token_hash, admin_password AS ssh_password FROM lab_runs WHERE id = ?1")
      .bind(id)
      .first<{ id: string; status: string; finished_at: string | null; callback_token_hash: string | null; ssh_password: string | null }>()) ?? null
  );
}

/** A run's live log as one text, oldest first; null when nothing was ever stored. */
export async function readLiveLog(env: Env, runId: string): Promise<{ text: string; updatedAt: string } | null> {
  const [rows, prunedUpto] = await Promise.all([db.liveLogRows(env, runId), db.liveLogPrunedUpto(env, runId)]);
  if (!rows.length) return null;
  // Only when the cap really dropped pieces: a missing piece 1 alone can be
  // one the Worker turned away as too big (413), which the runner skips.
  const note = prunedUpto !== null ? `##[warning]Earlier lines were dropped: the live log keeps the newest ${Math.round(LIVE_LOG_KEEP_BYTES / 1024)} KB. GitHub's full log shows here once the run has finished.\n` : "";
  const updatedAt = rows.reduce((t, r) => (r.at > t ? r.at : t), rows[0].at);
  return { text: note + rows.map((r) => r.text).join(""), updatedAt };
}
