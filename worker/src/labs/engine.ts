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
import * as db from "../db";
import { effectiveConfig } from "../settings";
import { acquireLock, releaseLock, labLock } from "../lock";
import { randomToken } from "../auth";
import { RunError } from "../runs";
import { labDef } from "./catalogue";
import { LAB_SLOTS, labNeeds, labsSettingsFrom, sessionTimeoutMin, type LabDef } from "../../../shared/labs";
import type { LabAction, LabPermissions } from "../../../shared/api";
import { directNet, dispatchLab, publicUrl, type Net } from "./net";
import { freeSlot, getLabRun, insertRun, insertSession, liveSessionOf, reserveSlot, runningCount, settleRun, slotsInUse, updateSession, getSession, type LabRunDb, type LabSessionRow } from "./store";
import { labGbpH } from "./prices";
import { labWarnings } from "./warnings";

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

const NO_PERMISSIONS: LabPermissions = { checkedAt: null, role: null, users: null, groups: null, message: null };

/** The permission check's last result (KV labs:permissions). */
export async function permissions(env: Env): Promise<LabPermissions> {
  try {
    const v = await env.STATUS.get("labs:permissions");
    return v ? { ...NO_PERMISSIONS, ...(JSON.parse(v) as LabPermissions) } : NO_PERMISSIONS;
  } catch {
    return NO_PERMISSIONS;
  }
}

export interface Availability {
  permissions: LabPermissions;
  live: number;
  maxRunning: number;
  slotsUsed: number;
  github: boolean;
}

export async function availability(env: Env): Promise<Availability> {
  const [perm, live, stored, used] = await Promise.all([permissions(env), runningCount(env), db.allSettings(env), slotsInUse(env)]);
  return { permissions: perm, live, maxRunning: labsSettingsFrom(stored).labsMaxRunning, slotsUsed: used, github: canDispatch(env) };
}

/** Why this lab cannot be deployed now (no override), or null (spec §9.2 "Not available"). */
export function unavailableReason(def: LabDef, a: Availability): string | null {
  if (!a.github) return "GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.";
  const needs = labNeeds(def);
  if (needs.role && a.permissions.role !== true) return "Needs the labs governance role: do the one-time setup, then Settings → Labs → Check permissions.";
  if (needs.graph && (a.permissions.users !== true || a.permissions.groups !== true)) return "Needs the Microsoft Graph permissions for lab users and groups: do the one-time setup, then Settings → Labs → Check permissions.";
  if (a.slotsUsed >= LAB_SLOTS) return `All ${LAB_SLOTS} address slots are in use. A slot is freed when a lab is clean in Azure again.`;
  if (a.live >= a.maxRunning) return `${a.maxRunning} labs are already running (the limit in Settings → Labs).`;
  return null;
}

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
 * the caller undoes its own part (a deploy's session and slot).
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

  const cfg = await effectiveConfig(env);
  const region = input.region ?? cfg.region;
  if (!test) {
    const warnings = await labWarnings(env, def, { hours: input.hours, region });
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
