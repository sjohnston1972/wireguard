// api/activity.ts
//
// Plain English: the Activity screen's data: the logbook for a chosen range
// (runs, watchman notes, dashboard changes, the figures across the top and a
// timeline), one run with its steps, and a run's GitHub log.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot, type Step } from "../state";
import { effectiveConfig } from "../settings";
import { canDispatch } from "../env";
import { RunError } from "../runs";
import { getJobs, getJobLogTail } from "../github";
import { AUDIT_KINDS, AUDIT_PAGE, ACTIVITY_RANGE_MS, describeChange, parseRange, runRow, eventsOf, timeline, activityKpis } from "../activity";
import type { ActivityResponse, RunDetailResponse, RunLogResponse } from "../../../shared/api";

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
    const sinceMs = now - ACTIVITY_RANGE_MS[range];
    const since = new Date(sinceMs).toISOString();
    const [allRuns, allNotes, inRangeChanges, rows, cfg] = await Promise.all([
      db.listRuns(c.env, RANGE_CAP),
      db.listAlerts(c.env, RANGE_CAP),
      c.env.DB.prepare("SELECT * FROM audit WHERE at >= ?1 ORDER BY at DESC, id DESC LIMIT ?2").bind(since, RANGE_CAP).all<db.AuditEntry>().then((r) => r.results),
      db.listAudit(c.env, { kind, q, limit: AUDIT_PAGE, offset: (page - 1) * AUDIT_PAGE }),
      effectiveConfig(c.env),
    ]);
    const runs = allRuns.filter((r) => Date.parse(r.requested_at) >= sinceMs);
    const notes = allNotes.filter((a) => Date.parse(a.at) >= sinceMs);
    const out: ActivityResponse = {
      range,
      now: new Date(now).toISOString(),
      kpis: activityKpis(runs, notes, inRangeChanges, range, now),
      timeline: timeline(eventsOf(runs, notes, inRangeChanges), range, now),
      runs: runs.map((r) => runRow(r, allRuns, cfg, now)),
      notes,
      all: eventsOf(runs, notes, inRangeChanges),
      changes: { rows: rows.slice(0, AUDIT_PAGE).map((r) => ({ ...r, lines: describeChange(r.before_json, r.after_json) })), more: rows.length > AUDIT_PAGE, page, kind, q },
    };
    return c.json(out);
  });

  api.get("/runs/:id", async (c) => {
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

  api.get("/runs/:id/log", async (c) => {
    const run = await db.getRun(c.env, c.req.param("id"));
    if (!run) return fail(c, 404, "not_found", "No such run.");
    if (!canDispatch(c.env)) return fail(c, 503, "not_configured", "GitHub is not set up, so there is no log to fetch.");
    if (!run.github_run_id) return fail(c, 404, "no_log", "This run has no GitHub log.");
    let log: string | null;
    try {
      const job = (await getJobs(c.env, run.github_run_id))[0];
      if (!job) return fail(c, 404, "no_log", "GitHub has no jobs for this run yet.");
      log = await getJobLogTail(c.env, job.id, 200_000);
    } catch (e) {
      throw new RunError(`Could not fetch the log from GitHub: ${(e as Error).message}`, "upstream");
    }
    if (log === null) return fail(c, 404, "no_log", "GitHub has no log for this run.");
    const out: RunLogResponse = { log };
    return c.json(out);
  });
}
