// labs/engine.ts
//
// Plain English: the lab change-control desk (labs spec §5, §7.1–§7.3). A lab
// session is one deploy of one lab, from Deploy until Azure is clean again;
// each workflow run for it (deploy, destroy, peer, unpeer, test) is a lab run.
// Starting one: take the lab's own run lock (RunLock "lab:<id>", never the
// gateway's), write the run, mint nothing secret into the payload (the run
// collects its callback token and admin password over OIDC, callbacks.ts),
// and press lab.yml's button. If GitHub refuses, the run is closed, the lock
// released and (for a deploy) the slot given back, so nothing is left held.
//
// A deploy needs: the lab in the catalogue, GitHub connected, no live session
// of that lab, the permissions the lab needs (Settings → Labs → Check
// permissions), a free slot and fewer than labs_max_running labs live. The
// slot is taken in one statement that also enforces the limit, after the
// lab's lock, so two clicks or two labs at once can never share a slot.

import type { Env } from "../env";
import { canDispatch } from "../env";
import { effectiveConfig } from "../settings";
import { getSnapshot } from "../state";
import { acquireLock, releaseLock, labLock, GATEWAY_LOCK } from "../lock";
import { randomToken } from "../auth";
import { RunError } from "../runs";
import { labDef, labIds } from "./catalogue";
import { readOrphans } from "./orphans";
import { LAB_SLOTS, sessionTimeoutMin, type LabDef } from "../../../shared/labs";
import type { LabAction, LabEndReason } from "../../../shared/api";
import { BudgetExceeded, cancelGh, directNet, dispatchLab, findLabRun, publicUrl, type Net } from "./net";
import { activeRunOf, freeSlot, getLabRun, insertRun, insertSession, liveSessionOf, reserveSlot, settleRun, slotsInUse, updateSession, getSession, type LabRunDb, type LabSessionRow } from "./store";
import { labGbpH } from "./prices";
import { labWarnings } from "./warnings";
import { availability, leftoversMessage, unavailableReason } from "./availability";
export { availability, blockersOf, permissions, unavailableReason, type Availability } from "./availability";

const MIN = 60_000;
const HOUR = 3_600_000;

/** "20261004120000": UTC, digits only (session ids must stay lowercase for the phone links). */
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const rand = () => randomToken().slice(0, 6);

export const newSessionId = (now: Date) => `ls-${stamp(now)}-${rand()}`;
export const newRunId = (action: LabAction, now: Date) => `lab-${action}-${stamp(now)}-${rand()}`;

/** §3.4 name_prefix: "l" + the lab's number (two digits) + 5 random lowercase letters and digits, e.g. l06k3x9q. */
export function namePrefix(labNumber: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return `l${String(labNumber).padStart(2, "0")}${[...b].map((x) => alphabet[x % alphabet.length]).join("")}`;
}

/**
 * A per-run admin password for the lab's VMs and users: four groups of five
 * from an unambiguous alphabet, always with an upper-case letter, a
 * lower-case letter and a digit, and hyphens (Azure's complexity rule).
 */
export function adminPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digit = "23456789";
  const all = upper + lower + digit;
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  const c = [...b].map((x) => all[x % all.length]);
  c[0] = upper[b[0] % upper.length];
  c[1] = lower[b[1] % lower.length];
  c[2] = digit[b[2] % digit.length];
  return [0, 5, 10, 15].map((i) => c.slice(i, i + 5).join("")).join("-");
}

/** The lab's workflow timeout and its lock's lifetime (spec §5, §7.3). A lab gone from the catalogue gets the cap. */
export function timeoutOf(def: LabDef | null): number {
  return def ? sessionTimeoutMin(def.timing) : 150;
}
export const lockTtlMs = (def: LabDef | null) => (timeoutOf(def) + 15) * MIN;

/** The run's payload, exactly the §5 keys (nothing secret: the repository and its logs are public). */
function payloadFor(env: Env, s: LabSessionRow, def: LabDef | null, action: LabAction, runId: string): Record<string, unknown> {
  const url = publicUrl(env);
  const peering = action === "peer" || action === "unpeer" ? true : action === "test" ? !!def && def.connectivity.peering !== "off" : s.peering !== "off";
  return {
    lab_id: s.lab_id,
    // The catalogue's version: lab.yml refuses one that differs from lab.yaml on main, and a
    // destroy must never be refused because the lab was updated while it ran.
    version: def?.version ?? s.lab_version,
    run_id: runId,
    session_id: s.id,
    region: s.region,
    secondary_region: s.secondary_region,
    slot_cidr: s.cidr,
    name_prefix: s.name_prefix,
    peering,
    timeout_min: timeoutOf(def),
    callback_url: `${url}/api/callback/lab`,
    secrets_url: `${url}/api/callback/lab-secrets`,
  };
}

export interface RunOptions {
  net?: Net;
  /** Kept with the run in D1 only (never dispatched): the chosen hours, "deploy anyway". */
  private?: Record<string, unknown>;
}

/**
 * Write the run and press lab.yml's button, with the lab's lock already held
 * by `runId`. On a refusal the run is closed as failed and the lock released;
 * the caller undoes its own part (a deploy's session and slot). When the
 * watch's allowance of calls runs out first (BudgetExceeded, nothing sent),
 * the run is removed instead, the lock released and BudgetExceeded rethrown,
 * so the watch tries again on its next run.
 */
async function dispatchRun(env: Env, s: LabSessionRow, action: LabAction, runId: string, by: string, reason: string | null, opts: RunOptions): Promise<LabRunDb> {
  const def = labDef(s.lab_id);
  const payload = payloadFor(env, s, def, action, runId);
  const now = new Date().toISOString();
  try {
    await insertRun(env, { id: runId, session_id: s.id, lab_id: s.lab_id, action, status: "queued", requested_at: now, requested_by: by, reason, admin_password: adminPassword(), payload_json: JSON.stringify({ ...payload, ...(opts.private ?? {}) }) });
  } catch (e) {
    await releaseLock(env, runId, false, labLock(s.lab_id));
    throw e;
  }
  try {
    await dispatchLab(env, opts.net ?? directNet(), action, payload);
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      // The watch's allowance ran out before anything was sent: nothing ran, so nothing is
      // recorded as failed (a failed destroy would count towards DESTROY_TRIES). The run row
      // goes, the lock is released, and the watch tries again on its next run.
      try {
        await env.DB.prepare("DELETE FROM lab_runs WHERE id = ?1 AND finished_at IS NULL").bind(runId).run();
      } finally {
        await releaseLock(env, runId, false, labLock(s.lab_id));
      }
      throw e;
    }
    const message = (e as Error).message;
    try {
      await settleRun(env, runId, { status: "failed", finished_at: new Date().toISOString(), error: message, admin_password: null });
    } finally {
      await releaseLock(env, runId, false, labLock(s.lab_id));
    }
    throw new RunError(message, "upstream");
  }
  return (await getLabRun(env, runId))!;
}

/**
 * Start a run for a session: take the lab's lock (TTL timeout_min + 15
 * minutes), write the run and dispatch lab.yml. Throws RunError (409) when
 * another run of the lab holds the lock, or (502) when GitHub refuses.
 * The caller moves the session's state.
 */
export async function startLabRun(env: Env, sid: string, action: LabAction, by: string, reason: string | null, opts: RunOptions = {}): Promise<LabRunDb> {
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.", "unavailable");
  const s = await getSession(env, sid);
  if (!s) throw new RunError("No such lab session.", "not_found");
  const def = labDef(s.lab_id);
  const runId = newRunId(action, new Date());
  const lock = await acquireLock(env, runId, { name: labLock(s.lab_id), ttlMs: lockTtlMs(def) });
  if (!lock.ok) throw new RunError(`Another run of this lab is in progress (${lock.holder?.runId}). Wait for it to finish.`);
  return dispatchRun(env, s, action, runId, by, reason, opts);
}

export interface DeployInput {
  hours: number;
  peer: boolean;
  region?: string;
  overBudgetOk?: boolean;
  capacityOk?: boolean;
}

/** Deploy a lab (or, with `test`, run its release test). Returns the new session and run. */
export async function deployLab(env: Env, labId: string, input: DeployInput, by: string, test = false): Promise<{ session: LabSessionRow; run: LabRunDb }> {
  const def = labDef(labId);
  if (!def) throw new RunError("No such lab.", "not_found");
  const a = await availability(env);
  if (!a.github) throw new RunError(unavailableReason(def, a)!, "unavailable");
  const live = await liveSessionOf(env, labId);
  if (live) throw new RunError(`${def.title} already has a session (${live.state.replace("_", " ")}). Tear it down first.`);
  const why = unavailableReason(def, a);
  if (why) throw new RunError(why, "unavailable");
  // Leftovers of an earlier session would clash with a new one (same group, same names).
  const dirty = await env.DB.prepare("SELECT id FROM lab_sessions WHERE lab_id = ?1 AND state = 'ended_dirty' AND slot IS NOT NULL LIMIT 1").bind(labId).first<{ id: string }>();
  if (dirty || (await readOrphans(env)).some((o) => o.labId === labId)) throw new RunError(leftoversMessage(def), "unavailable");

  const cfg = await effectiveConfig(env);
  const region = input.region ?? cfg.region;
  if (!test) {
    const warnings = await labWarnings(env, def, { hours: input.hours, region });
    const blocked = warnings.find((w) => w.kind === "budget" && !w.overridable);
    if (blocked) throw new RunError(blocked.message, "unavailable");
    const unconfirmed = warnings.filter((w) => (w.kind === "budget" && !input.overBudgetOk) || (w.kind === "capacity" && !input.capacityOk));
    if (unconfirmed.length) throw new RunError(`${unconfirmed.map((w) => w.message).join(" ")} Choose "Deploy anyway" to go ahead.`, "confirm_required");
  }

  const now = new Date();
  const at = now.toISOString();
  const sid = newSessionId(now);
  const action: LabAction = test ? "test" : "deploy";
  const runId = newRunId(action, now);
  // The lab's lock first: a second deploy of the same lab reserves nothing.
  const lock = await acquireLock(env, runId, { name: labLock(labId), ttlMs: lockTtlMs(def) });
  if (!lock.ok) throw new RunError(`Another run of ${def.title} is in progress (${lock.holder?.runId}). Wait for it to finish.`);

  let session: LabSessionRow | null = null;
  try {
    const slot = await reserveSlot(env, sid, at, a.maxRunning);
    if (!slot) {
      const used = await slotsInUse(env);
      throw new RunError(used >= LAB_SLOTS ? `All ${LAB_SLOTS} address slots are in use. A slot is freed when a lab is clean in Azure again.` : `${a.maxRunning} labs are already running (the limit in Settings → Labs).`, "unavailable");
    }
    const peering = def.connectivity.peering === "off" ? "off" : def.connectivity.peering === "required" || input.peer || test ? "waiting" : "off";
    session = {
      id: sid,
      lab_id: labId,
      lab_version: def.version,
      state: "deploying",
      test: test ? 1 : 0,
      region,
      secondary_region: def.regions.secondary,
      slot: slot.slot,
      cidr: slot.cidr,
      name_prefix: namePrefix(def.number),
      peering,
      requested_at: at,
      ready_at: null,
      ended_at: null,
      auto_destroy_at: null,
      max_until: new Date(now.getTime() + def.timing.max_h * HOUR).toISOString(),
      warned_at: null,
      est_gbp_h: await labGbpH(env, def, region, now),
      est_gbp: null,
      end_reason: null,
      outputs_json: null,
      leftovers_json: null,
      note: null,
    };
    await insertSession(env, session);
  } catch (e) {
    await freeSlot(env, sid);
    await releaseLock(env, runId, false, labLock(labId));
    throw e;
  }

  try {
    const run = await dispatchRun(env, session, action, runId, by, test ? "release test" : null, { private: { hours: input.hours, overBudgetOk: !!input.overBudgetOk } });
    return { session, run };
  } catch (e) {
    // Nothing was built: the session ends here, with a reason, and gives its slot back.
    await updateSession(env, sid, { state: "ended", ended_at: new Date().toISOString(), end_reason: "failed", est_gbp: 0 });
    await freeSlot(env, sid);
    throw e;
  }
}

// ── Stopping runs and tearing down ───────────────────────────────────────

/** The runs that may take the gateway's lock for peering (callbacks.ts handleLabPeer). */
const PEERING_ACTIONS = new Set(["deploy", "peer", "test"]);

/**
 * Stop a run in progress: GitHub's run is cancelled (found by its title if
 * GitHub had not said its number yet), the run is closed as cancelled and
 * its lock released, and the gateway's lock too if the run held it for
 * peering. A run GitHub cannot find is still closed: when it does start, its
 * secrets are refused and it stops at step 2.
 */
export async function cancelRun(env: Env, run: LabRunDb, net: Net, why: string): Promise<void> {
  let gh = run.github_run_id;
  if (!gh) gh = (await findLabRun(env, net, run.id).catch(() => null))?.id ?? null;
  if (gh) await cancelGh(env, net, gh).catch(() => false);
  await settleRun(env, run.id, { status: "cancelled", finished_at: new Date().toISOString(), error: why, ...(gh ? { github_run_id: gh } : {}) });
  await releaseLock(env, run.id, false, labLock(run.lab_id));
  // A run cancelled mid-peering never says "end": give the gateway its lock back, but only if
  // this run holds it (peer:<run id>); the lock refuses to release another holder's.
  if (PEERING_ACTIONS.has(run.action)) await releaseLock(env, `peer:${run.id}`, false, GATEWAY_LOCK);
}

/**
 * Tear a session down (spec §7.4): cancel its run in progress first (a deploy,
 * peer or test), then dispatch destroy and mark it tearing_down with its end
 * reason (the first reason given stays). `again` lets the cost guard replace
 * a destroy run that is stuck.
 */
export async function destroySession(env: Env, s: LabSessionRow, reason: LabEndReason, by: string, why: string, opts: { net?: Net; again?: boolean } = {}): Promise<LabRunDb> {
  if (s.state === "ended" || s.state === "ended_dirty") throw new RunError("That lab session has already ended.");
  const net = opts.net ?? directNet();
  const active = await activeRunOf(env, s.id);
  if (active) {
    if (active.action === "destroy" && !opts.again) throw new RunError(`${labDef(s.lab_id)?.title ?? s.lab_id} is already being torn down.`);
    await cancelRun(env, active, net, active.action === "destroy" ? "Replaced by a new tear-down (cost guard)." : `Cancelled: tearing the lab down (${why}).`);
  }
  let run: LabRunDb;
  try {
    run = await startLabRun(env, s.id, "destroy", by, why, { net });
  } catch (e) {
    // The deploy was stopped but the tear-down could not start: failed, so the watch tries again.
    // Out of the watch's calls: left as it is, and the watch's next run (five minutes on) tries again.
    if (active && s.state === "deploying" && !(e instanceof BudgetExceeded)) await updateSession(env, s.id, { state: "failed", end_reason: s.end_reason ?? reason }, "state = 'deploying'");
    throw e;
  }
  await updateSession(env, s.id, { state: "tearing_down", end_reason: s.end_reason ?? reason }, "state NOT IN ('ended', 'ended_dirty')");
  return run;
}

/** Tear down a lab's live session (the Tear down button, the phone's link). */
export async function destroyLab(env: Env, labId: string, reason: LabEndReason, by: string, why = "torn down from the dashboard"): Promise<LabRunDb> {
  const s = await liveSessionOf(env, labId);
  if (!s) throw new RunError(`${labDef(labId)?.title ?? labId} is not running.`);
  return destroySession(env, s, reason, by, why);
}

/** "19:00", London time, as every push and refusal says it. */
export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

/**
 * Move a running session's timer (spec §7.2, plan ruling 4): by whole hours
 * from its current end, or to max_until. Never past max_until: the API
 * refuses and says until when it can run; the phone's Extend 1h (`clamp`)
 * stops at the maximum instead. A new deadline earns a new 15-minute warning.
 */
export async function extendSession(env: Env, s: LabSessionRow, by: { hours?: number; toMax?: boolean; clamp?: boolean }): Promise<{ until: string; clamped: boolean }> {
  const title = labDef(s.lab_id)?.title ?? s.lab_id;
  if (s.state !== "running" || !s.auto_destroy_at) throw new RunError(`${title} is not running yet, so it has no timer to extend.`);
  const max = Date.parse(s.max_until);
  const current = Date.parse(s.auto_destroy_at);
  if (by.clamp && current >= max) throw new RunError(`${title} already runs to its maximum lifetime, ${hhmm(max)}.`);
  let next = by.toMax ? max : Math.max(current, Date.now()) + (by.hours ?? 1) * HOUR;
  let clamped = false;
  if (next > max) {
    if (!by.clamp) throw new RunError(`${title} can run until ${hhmm(max)} at most (its maximum lifetime). Extend to the maximum instead.`);
    next = max;
    clamped = true;
  }
  const until = new Date(next).toISOString();
  if (!(await updateSession(env, s.id, { auto_destroy_at: until, warned_at: null }, "state = 'running'"))) throw new RunError(`${title} is no longer running.`);
  return { until, clamped };
}

/** Extend a lab's running session from the dashboard. */
export async function extendLab(env: Env, labId: string, by: { hours?: number; toMax?: boolean }): Promise<string> {
  const s = await liveSessionOf(env, labId);
  if (!s) throw new RunError(`${labDef(labId)?.title ?? labId} is not running.`);
  return (await extendSession(env, s, by)).until;
}

/**
 * Clean up a lab's leftovers (spec §7.5, the Labs tab's Clean up): a destroy
 * run for that lab id, in a session of its own (state tearing_down, reason
 * orphan, no slot). The lab need not be in the catalogue any more: its id
 * then comes from the leftovers' names. Refused when the lab has a live
 * session (Tear down is the way), when nothing is known about the id, and
 * when the id is a prefix of a catalogue lab's (rg-lab-<id>-* would reach it).
 */
export async function cleanupLab(env: Env, labId: string, by: string): Promise<LabRunDb> {
  const def = labDef(labId);
  if (!def && !(await readOrphans(env)).some((o) => o.labId === labId)) throw new RunError(`No leftovers are known for ${labId}.`, "not_found");
  const clash = labIds().find((id) => id !== labId && id.startsWith(`${labId}-`));
  if (clash) throw new RunError(`A clean-up for ${labId} would also reach lab ${clash} (its safety net removes rg-lab-${labId}-*), so it is not offered. Remove those leftovers by hand.`);
  if (await liveSessionOf(env, labId)) throw new RunError(`${def?.title ?? labId} has a live session: use Tear down instead.`);
  if (!canDispatch(env)) throw new RunError("GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.", "unavailable");
  const now = new Date();
  const at = now.toISOString();
  const cfg = await effectiveConfig(env);
  const s: LabSessionRow = {
    id: newSessionId(now),
    lab_id: labId,
    lab_version: def?.version ?? 1,
    state: "tearing_down",
    test: 0,
    region: cfg.region,
    secondary_region: def?.regions.secondary ?? null,
    slot: null,
    cidr: null,
    name_prefix: namePrefix(Number(labId.split("-")[1]) || 0),
    // Leftover peerings on vnet-wg go too, unless the lab never peers.
    peering: def?.connectivity.peering === "off" ? "off" : "disconnected",
    requested_at: at,
    ready_at: null,
    ended_at: null,
    auto_destroy_at: null,
    max_until: at,
    warned_at: null,
    est_gbp_h: 0,
    est_gbp: null,
    end_reason: "orphan",
    outputs_json: null,
    leftovers_json: null,
    note: null,
  };
  await insertSession(env, s);
  try {
    return await startLabRun(env, s.id, "destroy", by, "clean up leftovers");
  } catch (e) {
    await env.DB.prepare("DELETE FROM lab_sessions WHERE id = ?1").bind(s.id).run();
    throw e;
  }
}

// ── Peering (spec §7.6) ──────────────────────────────────────────────────

/** A peer run for a running lab that can peer (its step 9 asks the Worker for the gateway's lock). */
export async function peerLab(env: Env, labId: string, by: string): Promise<LabRunDb> {
  const def = labDef(labId);
  const s = await liveSessionOf(env, labId);
  if (!def || def.connectivity.peering === "off") throw new RunError(`${def?.title ?? labId} never peers to the gateway.`);
  if (!s || s.state !== "running") throw new RunError(`${def.title} is not running.`);
  if (s.peering === "on") throw new RunError(`${def.title} is already peered to the gateway.`);
  const run = await startLabRun(env, s.id, "peer", by, "peer to the gateway");
  await updateSession(env, s.id, { peering: "waiting" }, "state = 'running'");
  return run;
}

/** An unpeer run: both sides of the peering and the DNS links go; the lab keeps running. */
export async function unpeerLab(env: Env, labId: string, by: string): Promise<LabRunDb> {
  const def = labDef(labId);
  const s = await liveSessionOf(env, labId);
  if (!def || def.connectivity.peering === "off") throw new RunError(`${def?.title ?? labId} never peers to the gateway.`);
  if (!s || s.state !== "running") throw new RunError(`${def.title} is not running.`);
  if (def.connectivity.peering === "required") throw new RunError(`${def.title} needs its peering; tear it down instead.`);
  if (s.peering === "off") throw new RunError(`${def.title} is not peered.`);
  return startLabRun(env, s.id, "unpeer", by, "unpeer from the gateway");
}

/** Re-peer: one peer run per running session whose peering is waiting or disconnected, once the gateway is up. */
export async function rePeerLabs(env: Env, by: string): Promise<{ started: string[]; failed: string[] }> {
  const snap = await getSnapshot(env);
  const waiting = (await env.DB.prepare("SELECT * FROM lab_sessions WHERE state = 'running' AND peering IN ('waiting', 'disconnected') ORDER BY requested_at").all<LabSessionRow>()).results;
  if (!waiting.length) return { started: [], failed: [] };
  if (snap.state !== "running" && snap.state !== "standby") throw new RunError("The gateway is not running, so there is nothing to peer to yet. Re-peer once it is.");
  const started: string[] = [];
  const failed: string[] = [];
  for (const s of waiting) {
    const title = labDef(s.lab_id)?.title ?? s.lab_id;
    try {
      await startLabRun(env, s.id, "peer", by, "re-peer after the gateway came back");
      await updateSession(env, s.id, { peering: "waiting" }, "state = 'running'");
      started.push(title);
    } catch (e) {
      failed.push(`${title}: ${(e as Error).message}`);
    }
  }
  return { started, failed };
}

/** Cancel the lab's run in progress, then tear the lab down (spec §7.2 /cancel). */
export async function cancelLab(env: Env, labId: string, by: string): Promise<LabRunDb> {
  const s = await liveSessionOf(env, labId);
  const active = s ? await activeRunOf(env, s.id) : null;
  if (!s || !active || active.action === "destroy") throw new RunError("Nothing to cancel: no deploy, peer or test is running for this lab.");
  return destroySession(env, s, "manual", by, "cancelled from the dashboard");
}
