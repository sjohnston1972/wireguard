// labs/view.ts
//
// Plain English: lab rows as the screens see them (shared/api.ts): a session
// (LabSession), a run (LabRunRow, and RunRow for the Activity list), with
// none of their secrets: no admin password, token hash or payload ever
// leaves through here. Either cloud's labs: an AWS lab's estimate counts the
// items AWS bills per started hour whole (AWS ruling A20).

import type { RunRow } from "../activity";
import type { LabAction, LabEndReason, LabPeering, LabRunRow, LabSession, LabSessionState } from "../../../shared/api";
import { LAB_STEPS, cloudOfId, sessionEstimateGbp, wholeHoursGbpH } from "../../../shared/labs";
import { labDef } from "./catalogue";
import type { LabRunDb, LabSessionRow } from "./store";

export const labTitle = (labId: string) => labDef(labId)?.title ?? labId;

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** "Deploying 3/11": steps done of the steps this action runs (LAB_STEPS by name), and the one in progress. Null before the first step. */
export function stepOf(action: string, stepsJson: string | null): LabRunRow["step"] {
  const steps = parse<{ name: string; status: string; conclusion: string | null }[]>(stepsJson, []);
  if (!Array.isArray(steps) || !steps.length) return null;
  const mine = LAB_STEPS.filter((s) => s.on.includes(action as LabAction));
  const byName = new Map(steps.map((s) => [s.name, s]));
  const done = mine.filter((s) => byName.get(s.name)?.status === "completed").length;
  const current = mine.find((s) => byName.get(s.name)?.status === "in_progress") ?? mine.find((s) => byName.get(s.name)?.status !== "completed") ?? null;
  return { done, of: mine.length, name: current?.name ?? null };
}

export function labRunRow(r: LabRunDb): LabRunRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    labId: r.lab_id,
    action: r.action as LabAction,
    status: r.status,
    requestedAt: r.requested_at,
    requestedBy: r.requested_by,
    reason: r.reason,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    githubRunUrl: r.github_run_url,
    error: r.error,
    step: stepOf(r.action, r.steps_json),
  };
}

/**
 * The live estimate so far: est_gbp_h × hours since it was requested (to its end, once ended), plus the rest of
 * the last started hour of the items billed per whole hour (`wholeGbpH`, their £/h; A20).
 */
export function estimateSoFar(s: Pick<LabSessionRow, "est_gbp_h" | "requested_at" | "ended_at" | "est_gbp">, now: number, wholeGbpH = 0): number {
  if (s.ended_at && s.est_gbp !== null) return s.est_gbp;
  const to = s.ended_at ? Date.parse(s.ended_at) : now;
  return sessionEstimateGbp(s.est_gbp_h, wholeGbpH, Math.max(0, to - Date.parse(s.requested_at)));
}

/** The £/h of a lab's items billed per whole started hour (0 for a lab with none, or gone from the catalogue). */
export const wholeGbpHOf = (labId: string): number => wholeHoursGbpH(labDef(labId)?.cost.items ?? []);

/** A session for the screens. `cost` overrides the estimate (the actual, once Azure has it). */
export function labSession(s: LabSessionRow, activeRun: LabRunDb | null, now: number, cost?: { gbp: number | null; basis: "estimate" | "actual" }): LabSession {
  const outputs = parse<{ private_ips?: Record<string, string>; connect?: string[]; users?: Record<string, string> } | null>(s.outputs_json, null);
  // Ruling P5: an AWS lab's users carry a Terraform-generated password; only GET /labs/:id/secret (Show) returns it.
  const users = outputs?.users ?? {};
  const shownUsers = cloudOfId(s.lab_id) === "aws" ? Object.fromEntries(Object.keys(users).map((k) => [k, ""])) : users;
  const leftovers = parse<string[] | null>(s.leftovers_json, null);
  return {
    id: s.id,
    labId: s.lab_id,
    labVersion: s.lab_version,
    title: labTitle(s.lab_id),
    state: s.state as LabSessionState,
    test: !!s.test,
    region: s.region,
    secondaryRegion: s.secondary_region,
    slot: s.slot,
    cidr: s.cidr,
    peering: s.peering as LabPeering,
    requestedAt: s.requested_at,
    readyAt: s.ready_at,
    endedAt: s.ended_at,
    autoDestroyAt: s.auto_destroy_at,
    maxUntil: s.max_until,
    estGbpH: s.est_gbp_h,
    costGbp: cost ? cost.gbp : estimateSoFar(s, now, wholeGbpHOf(s.lab_id)),
    costBasis: cost ? cost.basis : "estimate",
    endReason: s.end_reason as LabEndReason | null,
    note: s.note,
    outputs: outputs ? { privateIps: outputs.private_ips ?? {}, connect: outputs.connect ?? [], users: shownUsers } : null,
    leftovers: Array.isArray(leftovers) ? leftovers : null,
    activeRun: activeRun ? labRunRow(activeRun) : null,
  };
}

const STATUS: Record<string, RunRow["status"]> = { queued: "queued", running: "running", succeeded: "success", failed: "failure", cancelled: "cancelled" };

/** A lab run in the Activity list: a gateway-shaped row (apply for deploy, peer and test; destroy for destroy and unpeer) with `lab` carrying its own action (L0 ruling). */
export function activityRow(r: LabRunDb): RunRow {
  const took = r.finished_at ? Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at ?? r.requested_at)) / 1000) : null;
  return {
    id: r.id,
    action: r.action === "destroy" || r.action === "unpeer" ? "destroy" : "apply",
    status: STATUS[r.status] ?? "failure",
    requested_at: r.requested_at,
    requested_by: r.requested_by,
    started_at: r.started_at,
    finished_at: r.finished_at,
    github_run_url: r.github_run_url,
    public_ip: null,
    reason: r.reason,
    error: r.error,
    durationSeconds: took !== null && Number.isFinite(took) && took >= 0 ? took : null,
    sessionCostGbp: null,
    lab: { id: r.lab_id, title: labTitle(r.lab_id), action: r.action as LabAction },
    source: r.reason || (r.requested_by === "watchman" ? "watchman" : "dashboard"),
  };
}

const VERB: Record<string, [string, string]> = {
  deploy: ["deployed", "deploy"],
  destroy: ["torn down", "tear-down"],
  peer: ["peered", "peering"],
  unpeer: ["unpeered", "unpeering"],
  test: ["release test finished", "release test"],
};

/** A finished lab run as an Activity event (the feed and the timeline), named for its lab. */
export function activityEvent(r: LabRunDb): { at: string; type: "deploy" | "destroy" | "failure"; title: string; detail: string | null; ref: { kind: "run"; id: string } } | null {
  if (!r.finished_at || !["succeeded", "failed", "cancelled"].includes(r.status)) return null;
  const [done, noun] = VERB[r.action] ?? ["finished", "run"];
  const title = labTitle(r.lab_id);
  if (r.status === "succeeded") return { at: r.finished_at, type: r.action === "destroy" || r.action === "unpeer" ? "destroy" : "deploy", title: `Lab ${title}: ${done}`, detail: r.reason, ref: { kind: "run", id: r.id } };
  return { at: r.finished_at, type: "failure", title: `Lab ${title}: ${noun} ${r.status}`, detail: r.error ?? r.reason, ref: { kind: "run", id: r.id } };
}
