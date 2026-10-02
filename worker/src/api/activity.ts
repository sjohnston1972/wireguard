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
import { getJobsStatus, getJobLogTail } from "../github";
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
    const since = new Date(now - ACTIVITY_RANGE_MS[range]).toISOString();
    const [runs, notes, inRangeChanges, rows, cfg] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM runs WHERE requested_at >= ?1 ORDER BY requested_at DESC").bind(since).all<db.Run>().then((r) => r.results),
      c.env.DB.prepare("SELECT * FROM alerts WHERE at >= ?1 ORDER BY at DESC").bind(since).all<db.Alert>().then((r) => r.results),
      // The change log keeps at most 1000 entries (db.pruneAudit), so this read is bounded.
      c.env.DB.prepare("SELECT * FROM audit WHERE at >= ?1 ORDER BY at DESC, id DESC").bind(since).all<db.AuditEntry>().then((r) => r.results),
      db.listAudit(c.env, { kind, q, limit: AUDIT_PAGE, offset: (page - 1) * AUDIT_PAGE }),
      effectiveConfig(c.env),
    ]);
    // KPIs and the timeline count every row in the range; only the lists sent back are capped (newest first).
    const out: ActivityResponse = {
      range,
      now: new Date(now).toISOString(),
      kpis: activityKpis(runs, notes, inRangeChanges, range, now),
      timeline: timeline(eventsOf(runs, notes, inRangeChanges), range, now),
      runs: runs.slice(0, RANGE_CAP).map((r) => runRow(r, runs, cfg, now)),
      notes: notes.slice(0, RANGE_CAP),
      all: eventsOf(runs, notes, inRangeChanges).slice(0, RANGE_CAP),
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
      const got = await getJobsStatus(c.env, run.github_run_id);
      if (!got.ok && got.status !== 404) return fail(c, 502, "upstream", `GitHub refused or failed the request for this run's jobs (it answered ${got.status}), so the log could not be fetched.`);
      const job = got.jobs[0];
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
