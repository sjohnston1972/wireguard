// devseed-labs.ts
//
// Plain English: the dev seeder's lab story (scenario "labs", on top of the
// running gateway): lab 6 running and peered, lab 5 deploying at step 7 of
// 16, eight ended sessions with notes and costs, one session that ended
// dirty with its leftovers note, release tests for labs 4 to 7, Azure's
// daily cost per lab group, and a permission check that passed. Every other
// story wipes all of it (wipeLabs). Fixed values only, so a seed is
// repeatable; no real addresses beyond the lab pool, no real passwords.

import type { Env } from "./env";
import type { Step } from "./state";
import { LAB_STEPS, slotCidr } from "../../shared/labs";
import type { LabOrphan, LabPermissions } from "../../shared/api";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const USER = "dev@localhost";
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (ms: number) => iso(ms).replace(/[-:TZ.]/g, "").slice(0, 14);
const ghUrl = (n: number) => `https://ci.example.invalid/actions/runs/${7_100_000_000 + n}`;

/** The KV keys the lab engine keeps (shared/api.ts LabPermissions, LabOrphan[]). */
export const LABS_KV = { permissions: "labs:permissions", orphans: "labs:orphans" } as const;
/** The lab tables every story empties (lab_slots is kept, all 32 freed). */
export const LAB_TABLES = ["lab_sessions", "lab_runs", "lab_cost_days", "lab_release_tests"] as const;

/** Empty the lab tables, free every slot and forget the engine's KV records. */
export async function wipeLabs(env: Env): Promise<void> {
  await env.DB.batch([...LAB_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)), env.DB.prepare("UPDATE lab_slots SET session_id = NULL, since = NULL")]);
  for (const k of Object.values(LABS_KV)) await env.STATUS.delete(k);
}

/**
 * A run's 16 steps (LAB_STEPS) as the workflow reports them: steps the action
 * does not run are skipped once passed; the first `done` steps it runs are
 * finished, then (when `running`) the next is in progress and the rest queued.
 */
function steps(action: "deploy" | "destroy", startMs: number, done: number, running: boolean): Step[] {
  const runs = LAB_STEPS.map((s) => s.on.includes(action));
  // The index of the step in progress: the (done + 1)th that this action runs, or past the end.
  let current = LAB_STEPS.length;
  for (let i = 0, n = 0; i < runs.length; i++) if (runs[i] && ++n === done + 1) current = running ? i : LAB_STEPS.length;
  let t = startMs;
  return LAB_STEPS.map((s, i) => {
    if (i < current) {
      if (!runs[i]) return { name: s.name, status: "completed", conclusion: "skipped", started_at: null, completed_at: null };
      const from = t;
      t += (s.name === "Apply" || s.name === "Destroy" ? 150 : 20) * 1000;
      return { name: s.name, status: "completed", conclusion: "success", started_at: iso(from), completed_at: iso(t) };
    }
    if (i === current) return { name: s.name, status: "in_progress", conclusion: null, started_at: iso(t), completed_at: null };
    return { name: s.name, status: "queued", conclusion: null, started_at: null, completed_at: null };
  });
}

/** All 16 steps of an action, finished (skipped where the action does not run them). */
const finished = (action: "deploy" | "destroy", startMs: number) => steps(action, startMs, 16, false);

interface SessionSeed {
  id: string;
  lab: string;
  state: string;
  slot: number | null;
  peering: string;
  requested: number;
  ready: number | null;
  ended: number | null;
  autoDestroy: number | null;
  maxH: number;
  gbpH: number;
  endReason: string | null;
  note: string | null;
  outputs?: unknown;
  leftovers?: string[];
}

async function addSession(env: Env, s: SessionSeed, n: number): Promise<void> {
  const labNo = s.lab.split("-")[1];
  const hours = s.ended ? (s.ended - s.requested) / HOUR : null;
  await env.DB.prepare(
    `INSERT INTO lab_sessions (id, lab_id, lab_version, state, test, region, secondary_region, slot, cidr, name_prefix, peering, requested_at, ready_at, ended_at, auto_destroy_at, max_until, warned_at, est_gbp_h, est_gbp, end_reason, outputs_json, leftovers_json, note)
     VALUES (?1, ?2, CAST(1 AS INTEGER), ?3, CAST(0 AS INTEGER), 'uksouth', NULL, CAST(?4 AS INTEGER), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      s.id,
      s.lab,
      s.state,
      s.slot,
      s.slot === null ? null : slotCidr(s.slot),
      `l${labNo}${["k3x9q", "m2p7w", "a8d4r", "t5v1z", "h6n2c", "q9b3s", "w4e8y", "r7f5u", "c2g6j", "d9h3k", "e5j7m", "f1k8n"][n % 12]}`,
      s.peering,
      iso(s.requested),
      s.ready === null ? null : iso(s.ready),
      s.ended === null ? null : iso(s.ended),
      s.autoDestroy === null ? null : iso(s.autoDestroy),
      iso(s.requested + s.maxH * HOUR),
      s.gbpH,
      hours === null ? null : Math.round(s.gbpH * hours * 10000) / 10000,
      s.endReason,
      s.outputs ? JSON.stringify(s.outputs) : null,
      s.leftovers ? JSON.stringify(s.leftovers) : null,
      s.note,
    )
    .run();
  if (s.slot !== null) await env.DB.prepare("UPDATE lab_slots SET session_id = ?1, since = ?2 WHERE slot = CAST(?3 AS INTEGER)").bind(s.id, iso(s.requested), s.slot).run();
}

async function addRun(env: Env, r: { id: string; session: string; lab: string; action: string; status: string; requested: number; finished: number | null; steps: Step[]; n: number; password?: string | null; error?: string | null; outputs?: unknown }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lab_runs (id, session_id, lab_id, action, status, requested_at, requested_by, reason, started_at, finished_at, github_run_id, github_run_url, callback_token_hash, admin_password, payload_json, outputs_json, steps_json, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, CAST(?10 AS INTEGER), ?11, NULL, ?12, NULL, ?13, ?14, ?15)`,
  )
    .bind(r.id, r.session, r.lab, r.action, r.status, iso(r.requested), USER, iso(r.requested + 20_000), r.finished === null ? null : iso(r.finished), 7_100_000_000 + r.n, ghUrl(r.n), r.password ?? null, r.outputs ? JSON.stringify(r.outputs) : null, JSON.stringify(r.steps), r.error ?? null)
    .run();
}

/** Seed the lab story as of `now`. The gateway's running story is already in place. */
export async function seedLabs(env: Env, now: number): Promise<void> {
  let n = 0;
  const sid = (at: number, tail: string) => `ls-${stamp(at)}-${tail}`;
  const rid = (action: string, at: number, tail: string) => `lab-${action}-${stamp(at)}-${tail}`;

  // Lab 6: running for 45 minutes, peered, auto-destroy in 1 h 15 min.
  {
    const req = now - 52 * MIN;
    const ready = now - 45 * MIN;
    const id = sid(req, "b6r1");
    const outputs = { private_ips: { "pe-blob": "10.64.0.4" }, connect: ["https://l06k3x9q.blob.core.windows.net (private endpoint 10.64.0.4)"], users: {} };
    await addSession(env, { id, lab: "az104-06-blob-security", state: "running", slot: 0, peering: "on", requested: req, ready, ended: null, autoDestroy: ready + 2 * HOUR, maxH: 6, gbpH: 0.0082, endReason: null, note: null, outputs }, n);
    await addRun(env, { id: rid("deploy", req, "b6d1"), session: id, lab: "az104-06-blob-security", action: "deploy", status: "succeeded", requested: req, finished: ready, steps: finished("deploy", req + 20_000), n: ++n, password: "seed-only-not-a-password", outputs });
  }

  // Lab 5: deploying, at step 7 (Apply) of 16.
  {
    const req = now - 6 * MIN;
    const id = sid(req, "a5d2");
    await addSession(env, { id, lab: "az104-05-storage", state: "deploying", slot: 1, peering: "off", requested: req, ready: null, ended: null, autoDestroy: null, maxH: 6, gbpH: 0.0002, endReason: null, note: null }, n);
    await addRun(env, { id: rid("deploy", req, "a5d3"), session: id, lab: "az104-05-storage", action: "deploy", status: "running", requested: req, finished: null, steps: steps("deploy", req + 20_000, 6, true), n: ++n, password: "seed-only-not-a-password" });
  }

  // Eight ended sessions over the last two weeks, with notes and costs.
  const ended: { lab: string; daysAgo: number; hours: number; gbpH: number; reason: string; note: string | null }[] = [
    { lab: "az104-01-identity", daysAgo: 13, hours: 1, gbpH: 0, reason: "timer", note: "Custom role needed Microsoft.Compute/virtualMachines/start/action too." },
    { lab: "az104-02-policy", daysAgo: 12, hours: 1.2, gbpH: 0.0001, reason: "manual", note: "The lock stopped the delete, as it should." },
    { lab: "az104-05-storage", daysAgo: 10, hours: 2, gbpH: 0.0002, reason: "timer", note: null },
    { lab: "az104-04-cost", daysAgo: 9, hours: 0.5, gbpH: 0, reason: "manual", note: "Budget alerts take a day to show anything." },
    { lab: "az104-06-blob-security", daysAgo: 7, hours: 3, gbpH: 0.0082, reason: "timer", note: "SAS from the stored policy stopped working once the policy was deleted." },
    { lab: "az104-07-files", daysAgo: 5, hours: 2, gbpH: 0.0118, reason: "max", note: null },
    { lab: "az104-03-mgmt-groups", daysAgo: 3, hours: 1, gbpH: 0, reason: "timer", note: "Policy inheritance shows on the child groups after a few minutes." },
    { lab: "az104-06-blob-security", daysAgo: 2, hours: 1.5, gbpH: 0.0082, reason: "manual", note: null },
  ];
  for (const [i, e] of ended.entries()) {
    const req = Math.floor((now - e.daysAgo * DAY) / HOUR) * HOUR + 9 * HOUR;
    const ready = req + 4 * MIN;
    const end = ready + e.hours * HOUR;
    const id = sid(req, `e${i}x0`);
    await addSession(env, { id, lab: e.lab, state: "ended", slot: null, peering: "off", requested: req, ready, ended: end + 3 * MIN, autoDestroy: ready + Math.ceil(e.hours) * HOUR, maxH: 6, gbpH: e.gbpH, endReason: e.reason, note: e.note }, n);
    await addRun(env, { id: rid("deploy", req, `e${i}d0`), session: id, lab: e.lab, action: "deploy", status: "succeeded", requested: req, finished: ready, steps: finished("deploy", req + 20_000), n: ++n });
    await addRun(env, { id: rid("destroy", end, `e${i}x1`), session: id, lab: e.lab, action: "destroy", status: "succeeded", requested: end, finished: end + 3 * MIN, steps: finished("destroy", end + 20_000), n: ++n });
    // Azure's figure for that day, a little over the estimate (storage and transactions).
    await env.DB.prepare("INSERT OR REPLACE INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(iso(req).slice(0, 10), `rg-lab-${e.lab}`, e.lab, Math.round((e.gbpH * e.hours + 0.002) * 10000) / 10000, iso(now - 6 * HOUR))
      .run();
  }

  // One session ended dirty: a share snapshot was left behind, so its slot stays held until a clean sweep.
  {
    const req = now - 26 * HOUR;
    const end = req + 2 * HOUR;
    const id = sid(req, "d7z9");
    const leftovers = ["rg-lab-az104-07-files"];
    await addSession(env, { id, lab: "az104-07-files", state: "ended_dirty", slot: 2, peering: "off", requested: req, ready: req + 5 * MIN, ended: end + 4 * MIN, autoDestroy: req + 5 * MIN + 2 * HOUR, maxH: 6, gbpH: 0.0118, endReason: "timer", note: null, leftovers }, n);
    await addRun(env, { id: rid("deploy", req, "d7d0"), session: id, lab: "az104-07-files", action: "deploy", status: "succeeded", requested: req, finished: req + 5 * MIN, steps: finished("deploy", req + 20_000), n: ++n });
    await addRun(env, { id: rid("destroy", end, "d7x1"), session: id, lab: "az104-07-files", action: "destroy", status: "failed", requested: end, finished: end + 4 * MIN, steps: finished("destroy", end + 20_000), n: ++n, error: "Verify clean: rg-lab-az104-07-files is still there." });
    const since = iso(end + 40 * MIN);
    const orphans: LabOrphan[] = [{ labId: "az104-07-files", names: leftovers, since }];
    await env.STATUS.put(LABS_KV.orphans, JSON.stringify(orphans));
    await env.DB.prepare("INSERT INTO alerts (at, kind, message, run_id, acknowledged) VALUES (?1, 'cost_guard', ?2, NULL, 0)").bind(since, `Lab leftovers: ${leftovers.join(", ")}. Clean up from the Labs tab.`).run();
  }

  // Release tests: labs 4 to 6 passed at version 1; lab 7's test left something behind.
  const tests: [string, number, string, number, number, number, string[]][] = [
    ["az104-04-cost", 11, "pass", 95, 80, 0.0001, []],
    ["az104-05-storage", 11, "pass", 160, 140, 0.0002, []],
    ["az104-06-blob-security", 8, "pass", 230, 170, 0.0012, []],
    ["az104-07-files", 4, "fail", 290, 260, 0.0021, ["rg-lab-az104-07-files"]],
  ];
  for (const [lab, daysAgo, result, dep, des, gbp, left] of tests) {
    const at = now - daysAgo * DAY;
    await env.DB.prepare("INSERT INTO lab_release_tests (lab_id, version, at, run_id, result, deploy_seconds, destroy_seconds, est_gbp, leftovers_json) VALUES (?1, CAST(1 AS INTEGER), ?2, ?3, ?4, CAST(?5 AS INTEGER), CAST(?6 AS INTEGER), ?7, ?8)")
      .bind(lab, iso(at), rid("test", at, "rt00"), result, dep, des, gbp, JSON.stringify(left))
      .run();
  }

  const permissions: LabPermissions = { checkedAt: iso(now - DAY), role: true, users: true, groups: true, message: null };
  await env.STATUS.put(LABS_KV.permissions, JSON.stringify(permissions));

}
