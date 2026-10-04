// labs/settle.ts
//
// Plain English: closing a lab run and moving its session on, whichever way
// the news arrives: the workflow's result callback (callbacks.ts) or, when
// that never came, GitHub's own status (watch.ts). Only the first caller
// settles a run (one conditional UPDATE); the second finds it closed and
// changes nothing.
//
//   deploy   ready: running, timer = ready + the chosen hours, never past
//            max_until (plan ruling 4). Failed: failed (the watch tears it
//            down after 15 minutes).
//   destroy  clean: ended, slot freed. Not clean: ended_dirty, the slot kept
//            until the orphan sweep finds Azure clean, and a note. No clean
//            check at all (the run died early): failed again, so the watch
//            retries, at most three times before it is ended_dirty.
//   test     both halves at once: a lab_release_tests row (pass only when
//            clean), then ended or ended_dirty with reason test.
//   peer     peering on (or still waiting); unpeer: off.
// Every end clears the session's admin passwords and records est_gbp.

import type { Env } from "../env";
import * as db from "../db";
import { notify } from "../notify";
import { dashboardButton } from "../actions";
import { releaseLock, labLock } from "../lock";
import { labDef } from "./catalogue";
import type { LabEndReason } from "../../../shared/api";
import { labIsClean } from "./orphans";
import { clearPasswords, freeSlot, getSession, payloadOf, settleRun, updateSession, type LabRunDb, type LabSessionRow } from "./store";

const HOUR = 3_600_000;

/** A run result's outputs, checked and trimmed: names and addresses only, never a secret. */
export interface LabOutputs {
  private_ips: Record<string, string>;
  connect: string[];
  users: Record<string, string>;
  peer_vnet_id: string | null;
  clean: boolean | null;
  leftovers: string[];
  deploy_seconds: number | null;
  destroy_seconds: number | null;
}

/** The output keys a result may carry (§5 step 16, §3.4 outputs). Anything else is refused. */
export const OUTPUT_KEYS = ["private_ips", "connect", "users", "peer_vnet_id", "clean", "leftovers", "deploy_seconds", "destroy_seconds"] as const;

const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.length <= max ? v : null);

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
    const s = str(x, 300);
    if (s !== null && k.length <= 100) out[k] = s;
  }
  return out;
}

const strList = (v: unknown, n = 50): string[] => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, 300)).filter((x): x is string => x !== null) : []);
const secs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Outputs from a result body, or a refusal naming the first key it does not know. */
export function readOutputs(v: unknown): { ok: true; outputs: LabOutputs } | { ok: false; field: string } {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  for (const k of Object.keys(o)) if (!(OUTPUT_KEYS as readonly string[]).includes(k)) return { ok: false, field: `outputs.${k}` };
  return {
    ok: true,
    outputs: {
      private_ips: strMap(o.private_ips),
      connect: strList(o.connect, 20),
      users: strMap(o.users),
      peer_vnet_id: str(o.peer_vnet_id, 500),
      clean: typeof o.clean === "boolean" ? o.clean : null,
      leftovers: strList(o.leftovers),
      deploy_seconds: secs(o.deploy_seconds),
      destroy_seconds: secs(o.destroy_seconds),
    },
  };
}

const EMPTY: LabOutputs = { private_ips: {}, connect: [], users: {}, peer_vnet_id: null, clean: null, leftovers: [], deploy_seconds: null, destroy_seconds: null };

const titleOf = (labId: string) => labDef(labId)?.title ?? labId;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

/** How many destroys a session may fail without a clean check before it is left ended_dirty for the orphan sweep. */
export const DESTROY_TRIES = 3;

/**
 * End a session: ended (clean, slot freed) or ended_dirty (leftovers kept,
 * slot held, one note). Always records the estimate and forgets the
 * session's passwords.
 */
export async function endSession(env: Env, s: LabSessionRow, clean: boolean, leftovers: string[], reason: LabEndReason, now = new Date()): Promise<void> {
  const ended = now.toISOString();
  const est = Math.round(s.est_gbp_h * Math.max(0, now.getTime() - Date.parse(s.requested_at)) / HOUR * 1e6) / 1e6;
  const changed = await updateSession(
    env,
    s.id,
    { state: clean ? "ended" : "ended_dirty", ended_at: ended, est_gbp: est, end_reason: s.end_reason ?? reason, leftovers_json: clean ? null : JSON.stringify(leftovers) },
    "state NOT IN ('ended', 'ended_dirty')",
  );
  await clearPasswords(env, s.id);
  if (!changed) return;
  if (clean) {
    await freeSlot(env, s.id);
    // The clean check covers everything named for the lab: older leftovers and the slots they held go too.
    await labIsClean(env, s.lab_id);
    return;
  }
  const names = leftovers.length ? leftovers.join(", ") : `something in rg-lab-${s.lab_id}`;
  const msg = `Lab leftovers: ${names}. ${titleOf(s.lab_id)} did not tear down cleanly; Clean up from the Labs tab.`;
  await db.addAlert(env, "cost_guard", msg);
  await notify(env, "wg-admin: lab leftovers", msg, { priority: 4, tags: ["rotating_light"], buttons: [dashboardButton(env, "Open Labs", "/labs")] });
}

/** Record a release test (spec §11.2). Pass needs a successful run and a clean check. */
async function recordReleaseTest(env: Env, run: LabRunDb, s: LabSessionRow, ok: boolean, out: LabOutputs, now: Date): Promise<boolean> {
  const pass = ok && out.clean === true;
  const version = Number(payloadOf(run).version ?? s.lab_version);
  const est = Math.round(s.est_gbp_h * Math.max(0, now.getTime() - Date.parse(s.requested_at)) / HOUR * 1e6) / 1e6;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO lab_release_tests (lab_id, version, at, run_id, result, deploy_seconds, destroy_seconds, est_gbp, leftovers_json) VALUES (?1, CAST(?2 AS INTEGER), ?3, ?4, ?5, CAST(?6 AS INTEGER), CAST(?7 AS INTEGER), ?8, ?9)",
  )
    .bind(s.lab_id, version, now.toISOString(), run.id, pass ? "pass" : "fail", out.deploy_seconds, out.destroy_seconds, est, JSON.stringify(out.leftovers))
    .run();
  return pass;
}

/**
 * Close `run` with its result and move its session on. Returns false (and
 * does nothing) when the run was already closed by someone else.
 */
export async function finishRun(env: Env, run: LabRunDb, result: { ok: boolean; outputs?: LabOutputs | null; error?: string | null; via: string }, now = new Date()): Promise<boolean> {
  const out = result.outputs ?? EMPTY;
  const at = now.toISOString();
  const settled = await settleRun(env, run.id, {
    status: result.ok ? "succeeded" : "failed",
    finished_at: at,
    outputs_json: JSON.stringify(out),
    error: result.ok ? null : (result.error ?? `The workflow reported failure (${result.via}).`),
  });
  if (!settled) return false;
  await releaseLock(env, run.id, false, labLock(run.lab_id));
  const s = await getSession(env, run.session_id);
  if (!s) return true;
  const title = titleOf(s.lab_id);

  switch (run.action) {
    case "deploy": {
      if (s.state !== "deploying") return true; // cancelled or torn down meanwhile
      if (result.ok) {
        const hours = Number(payloadOf(run).hours) || 1;
        const until = Math.min(now.getTime() + hours * HOUR, Date.parse(s.max_until));
        const outputs = { private_ips: out.private_ips, connect: out.connect, users: out.users, peer_vnet_id: out.peer_vnet_id };
        await updateSession(env, s.id, { state: "running", ready_at: at, auto_destroy_at: new Date(until).toISOString(), outputs_json: JSON.stringify(outputs) }, "state = 'deploying'");
        await notify(env, `wg-admin: lab ready`, `${title} is ready. It tears down at ${hhmm(new Date(until).toISOString())}.`, { tags: ["test_tube"], buttons: [dashboardButton(env, "Open the lab", `/labs/${s.lab_id}`)] });
      } else {
        await updateSession(env, s.id, { state: "failed" }, "state = 'deploying'");
        await db.addAlert(env, "info", `Lab ${title} failed to deploy${result.error ? `: ${result.error}` : ""}. It is torn down in 15 minutes unless you tear it down first.`, null);
      }
      return true;
    }
    case "test": {
      await recordReleaseTest(env, run, s, result.ok, out, now);
      const fresh = (await getSession(env, s.id)) ?? s;
      if (out.clean === true) await endSession(env, fresh, true, [], "test", now);
      else if (out.clean === false) await endSession(env, fresh, false, out.leftovers, "test", now);
      else await updateSession(env, s.id, { state: "failed", end_reason: s.end_reason ?? "test" }, "state NOT IN ('ended', 'ended_dirty')");
      return true;
    }
    case "destroy": {
      if (out.clean === true) {
        await endSession(env, s, true, [], "manual", now);
      } else if (out.clean === false) {
        await endSession(env, s, false, out.leftovers, "manual", now);
      } else {
        // The clean check never ran (the run died early): try again, a few times.
        const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM lab_runs WHERE session_id = ?1 AND action = 'destroy' AND status IN ('failed', 'cancelled')").bind(s.id).first<{ n: number }>();
        if (Number(failed?.n ?? 0) >= DESTROY_TRIES) await endSession(env, s, false, [`unknown: ${DESTROY_TRIES} tear-downs ended without a clean check`], "failed", now);
        else await updateSession(env, s.id, { state: "failed", end_reason: s.end_reason ?? "failed" }, "state NOT IN ('ended', 'ended_dirty')");
      }
      return true;
    }
    case "peer":
      await updateSession(env, s.id, { peering: result.ok ? "on" : s.peering === "on" ? "on" : "waiting" }, "state NOT IN ('ended', 'ended_dirty')");
      return true;
    case "unpeer":
      if (result.ok) await updateSession(env, s.id, { peering: "off" }, "state NOT IN ('ended', 'ended_dirty')");
      return true;
    default:
      return true;
  }
}
