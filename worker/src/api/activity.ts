// api/activity.ts
//
// Plain English: the Activity screen's data: the logbook for a chosen range
// (runs, watchman notes, dashboard changes, the figures across the top and a
// timeline), one run with its steps, and a run's log (live while it runs,
// GitHub's once it has finished).

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot, type Step } from "../state";
import { effectiveConfig } from "../settings";
import { canDispatch } from "../env";
import { getJobsStatus, getJobLogTail } from "../github";
import { isActiveRun, readLiveLog } from "../livelog";
import { AUDIT_KINDS, AUDIT_PAGE, ACTIVITY_RANGE_MS, describeChange, parseRange, runRow, eventsOf, timeline, activityKpis } from "../activity";
import type { ActivityResponse, RunDetailResponse, RunLogResponse } from "../../../shared/api";
import { getLabRun, type LabRunDb } from "../labs/store";
import { activityEvent, activityRow } from "../labs/view";

/** Most rows of any one list in a range. */
const RANGE_CAP = 200;

export function registerActivity(api: Hono<ApiEnv>): void {
  api.get("/activity", async (c) => {
    const range = parseRange(c.req.query("range") ?? "24h");
    if (!range) return fail(c, 400, "bad_input", "range must be one of 1h, 6h, 24h, 7d or 30d.", "range");
    // The change log's filter and page, as on the old page.
    const kind = AUDIT_KINDS.find((k) => k.value === c.req.query("kind"))?.value ?? "";
    const q = (c.req.query("q") ?? "").trim().slice(0, 60);
    const page = Math.max(1, Math.min(1000, Number(c.req.query("page")) || 1));
    const now = Date.now();
    const since = new Date(now - ACTIVITY_RANGE_MS[range]).toISOString();
    // The equally long period just before, for the "vs yesterday" figures: [before, since).
    const before = new Date(now - 2 * ACTIVITY_RANGE_MS[range]).toISOString();
    const [runs, notes, inRangeChanges, rows, cfg, prevRuns, prevNotes, prevChanges] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM runs WHERE requested_at >= ?1 ORDER BY requested_at DESC").bind(since).all<db.Run>().then((r) => r.results),
      c.env.DB.prepare("SELECT * FROM alerts WHERE at >= ?1 ORDER BY at DESC").bind(since).all<db.Alert>().then((r) => r.results),
      // The change log keeps at most 1000 entries (db.pruneAudit), so this read is bounded.
      c.env.DB.prepare("SELECT * FROM audit WHERE at >= ?1 ORDER BY at DESC, id DESC").bind(since).all<db.AuditEntry>().then((r) => r.results),
      db.listAudit(c.env, { kind, q, limit: AUDIT_PAGE, offset: (page - 1) * AUDIT_PAGE }),
      effectiveConfig(c.env),
      c.env.DB.prepare("SELECT * FROM runs WHERE requested_at >= ?1 AND requested_at < ?2").bind(before, since).all<db.Run>().then((r) => r.results),
      c.env.DB.prepare("SELECT * FROM alerts WHERE at >= ?1 AND at < ?2").bind(before, since).all<db.Alert>().then((r) => r.results),
      c.env.DB.prepare("SELECT * FROM audit WHERE at >= ?1 AND at < ?2").bind(before, since).all<db.AuditEntry>().then((r) => r.results),
    ]);
    // Lab runs (lab_runs) join the run list and the feed, named for their lab (RunRow.lab); the
    // gateway's figures across the top stay the gateway's.
    const labRuns = (await c.env.DB.prepare("SELECT * FROM lab_runs WHERE requested_at >= ?1 ORDER BY requested_at DESC").bind(since).all<LabRunDb>()).results;
    const events = eventsOf(runs, notes, inRangeChanges)
      .concat(labRuns.map(activityEvent).filter((e): e is NonNullable<ReturnType<typeof activityEvent>> => e !== null))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const runRows = runs
      .map((r) => runRow(r, runs, cfg, now))
      .concat(labRuns.map(activityRow))
      .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at));
    // KPIs and the timeline count every row in the range; only the lists sent back are capped (newest first).
    const out: ActivityResponse = {
      range,
      now: new Date(now).toISOString(),
      kpis: activityKpis(runs, notes, inRangeChanges, range, now),
      // The same figures as if "now" were one range ago: the window [now - 2 ranges, now - 1 range].
      previous: activityKpis(prevRuns, prevNotes, prevChanges, range, now - ACTIVITY_RANGE_MS[range]),
      timeline: timeline(events, range, now),
      runs: runRows.slice(0, RANGE_CAP),
      notes: notes.slice(0, RANGE_CAP),
      all: events.slice(0, RANGE_CAP),
      changes: { rows: rows.slice(0, AUDIT_PAGE).map((r) => ({ ...r, lines: describeChange(r.before_json, r.after_json) })), more: rows.length > AUDIT_PAGE, page, kind, q },
    };
    return c.json(out);
  });

  api.get("/runs/:id", async (c) => {
    // A lab run (labs spec §7.2): its steps as last read from GitHub, kept with the run.
    if (c.req.param("id").startsWith("lab-")) {
      const lab = await getLabRun(c.env, c.req.param("id"));
      if (!lab) return fail(c, 404, "not_found", "No such run.");
      let steps: Step[] = [];
      try {
        const v = JSON.parse(lab.steps_json ?? "[]");
        if (Array.isArray(v)) steps = v;
      } catch {
        steps = [];
      }
      const out: RunDetailResponse = { run: activityRow(lab), steps, active: isActiveRun(lab as Pick<db.Run, "status" | "finished_at">) };
      return c.json(out);
    }
    const run = await db.getRun(c.env, c.req.param("id"));
    if (!run) return fail(c, 404, "not_found", "No such run.");
    const [runs, cfg, snap, active] = await Promise.all([db.listRuns(c.env, RANGE_CAP), effectiveConfig(c.env), getSnapshot(c.env), db.activeRun(c.env)]);
    const isActive = active?.id === run.id;
    let steps: Step[] = [];
    if (isActive) steps = snap.steps ?? [];
    else if (run.steps_json) {
      try {
        const v = JSON.parse(run.steps_json);
        if (Array.isArray(v)) steps = v;
      } catch {
        steps = [];
      }
    }
    const out: RunDetailResponse = { run: runRow(run, runs, cfg), steps, active: isActive };
    return c.json(out);
  });

  // A run's log. While the run is going: the live log the workflow sends as
  // it runs (livelog.ts), even when nothing has arrived yet; GitHub has no log
  // for an unfinished job. Once it has finished: GitHub's full log, or the
  // live copy when GitHub has none (not yet, gone, or unreachable).
  api.get("/runs/:id/log", async (c) => {
    const id = c.req.param("id");
    // A lab run's log comes the same two ways (live while it runs, then GitHub's).
    const lab = id.startsWith("lab-") ? await getLabRun(c.env, id) : null;
    const run = lab ? ({ id: lab.id, status: lab.status, finished_at: lab.finished_at, github_run_id: lab.github_run_id } as Pick<db.Run, "id" | "status" | "finished_at" | "github_run_id">) : await db.getRun(c.env, id);
    if (!run) return fail(c, 404, "not_found", "No such run.");
    if (isActiveRun(run)) {
      const live = await readLiveLog(c.env, run.id);
      const out: RunLogResponse = { log: live?.text ?? "", source: "live", active: true, updatedAt: live?.updatedAt ?? null };
      return c.json(out);
    }

    // Finished. The live copy is the fallback for every way GitHub can come up empty.
    const fallback = async (status: 404 | 502 | 503, code: string, message: string) => {
      const live = await readLiveLog(c.env, run.id);
      if (live) {
        const out: RunLogResponse = { log: live.text, source: "live", active: false, updatedAt: live.updatedAt };
        return c.json(out);
      }
      return fail(c, status, code, message);
    };
    if (!canDispatch(c.env)) return fallback(503, "not_configured", "GitHub is not set up, so there is no log to fetch.");
    if (!run.github_run_id) return fallback(404, "no_log", "This run has no GitHub log, and no live log was kept.");
    let log: string | null;
    try {
      const got = await getJobsStatus(c.env, run.github_run_id);
      if (!got.ok && got.status !== 404) return fallback(502, "upstream", `GitHub refused or failed the request for this run's jobs (it answered ${got.status}), so the log could not be fetched.`);
      const job = got.jobs[0];
      if (!job) return fallback(404, "no_log", "GitHub has no jobs for this run yet.");
      log = await getJobLogTail(c.env, job.id, 200_000);
    } catch (e) {
      return fallback(502, "upstream", `Could not fetch the log from GitHub: ${(e as Error).message}`);
    }
    if (log === null) return fallback(404, "no_log", "GitHub has no log for this run (it can take a minute after a run ends), and no live log was kept.");
    const out: RunLogResponse = { log, source: "github", active: false, updatedAt: null };
    return c.json(out);
  });
}
