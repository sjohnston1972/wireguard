// api-activity.test.ts
//
// Plain English: the Activity screen's data. The logbook turned into events,
// a timeline and the figures across the top, for a chosen range; the change
// log with its filter and pages; one run with its steps; a run's GitHub log.
// And that nothing secret (SSH password, token hashes, run payload) leaks.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { startDeploy } from "../src/runs";
import { getSnapshot, saveSnapshot } from "../src/state";
import { eventsOf, timeline, activityKpis, runRow, ACTIVITY_RANGE_MS } from "../src/activity";
import { effectiveConfig } from "../src/settings";
import type { Env } from "../src/env";
import type { Run, Alert, AuditEntry } from "../src/db";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

function mkRun(id: string, action: Run["action"], status: Run["status"], requestedAgo: number, tookMs: number | null, extra: Partial<Run> = {}): Run {
  return {
    id, action, status, requested_at: ago(requestedAgo), requested_by: "steven", started_at: ago(requestedAgo),
    finished_at: tookMs === null ? null : new Date(NOW - requestedAgo + tookMs).toISOString(),
    github_run_id: null, github_run_url: null, callback_token_hash: "CBHASH", agent_token_hash: "AGHASH", payload_json: '{"x":"PAYLOADSECRET"}',
    outputs_json: null, public_ip: null, auto_destroy_at: null, reason: null, error: null, ssh_password: "hunter2-secret", steps_json: null, ...extra,
  };
}
const note = (id: number, kind: string, agoMs: number): Alert => ({ id, at: ago(agoMs), kind, message: `${kind} happened`, run_id: null, acknowledged: 0 });
const change = (id: number, action: string, agoMs: number): AuditEntry => ({ id, at: ago(agoMs), user: "steven", action, target: "x", before_json: null, after_json: '{"a":1}' });

// Finished at: r1 10:20, r2 07:30, r3 11:10, r4 09:00, r5 three days ago.
const RUNS: Run[] = [
  mkRun("r6", "apply", "running", 10 * MIN, null),
  mkRun("r3", "destroy", "success", HOUR, 10 * MIN),
  mkRun("r1", "apply", "success", 2 * HOUR, 20 * MIN),
  mkRun("r4", "apply", "failure", 3 * HOUR, 0, { error: "boom" }),
  mkRun("r2", "apply", "success", 5 * HOUR, 30 * MIN),
  mkRun("r5", "apply", "success", 3 * DAY, 60 * MIN),
];
const NOTES: Alert[] = [note(1, "failure", 30 * MIN), note(2, "deploy", 2 * HOUR), note(3, "drift", 6 * HOUR), note(4, "info", 2 * DAY)];
const CHANGES: AuditEntry[] = [change(1, "client.add", 20 * MIN), change(2, "firewall.rule.add", 90 * MIN), change(3, "settings.save", 3 * DAY)];

describe("eventsOf", () => {
  it("turns runs, notes and changes into one list, newest first", () => {
    const ev = eventsOf(RUNS, NOTES, CHANGES);
    // Newest first.
    const times = ev.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The unfinished run and the routine deploy note are left out.
    expect(ev.find((e) => e.ref.kind === "run" && e.ref.id === "r6")).toBeUndefined();
    expect(ev.find((e) => e.ref.kind === "note" && e.ref.id === 2)).toBeUndefined();
    const type = (kind: string, id: string | number) => ev.find((e) => e.ref.kind === kind && e.ref.id === id)?.type;
    expect(type("run", "r1")).toBe("deploy");
    expect(type("run", "r3")).toBe("destroy");
    expect(type("run", "r4")).toBe("failure");
    expect(type("note", 1)).toBe("watchman");
    expect(type("note", 4)).toBe("watchman");
    expect(type("change", 1)).toBe("config");
    expect(type("change", 2)).toBe("firewall");
  });

  it("calls a cancelled run a failure and leaves out session notes", () => {
    const ev = eventsOf([mkRun("c", "apply", "cancelled", HOUR, 1000)], [note(9, "session", MIN), note(8, "destroy", MIN)], []);
    expect(ev.map((e) => e.type)).toEqual(["failure"]);
  });
});

describe("timeline", () => {
  it("has one bucket per step across the whole range, empty ones included, oldest first", () => {
    const tl = timeline(eventsOf(RUNS, NOTES, CHANGES), "24h", NOW);
    expect(tl).toHaveLength(24);
    expect(tl[0].start).toBe(ago(24 * HOUR));
    expect(tl[23].start).toBe(ago(HOUR));
    const at = (i: number) => tl[i].counts;
    expect(at(22).deploy).toBe(1); // r1 finished 10:20
    expect(at(22).firewall).toBe(1); // 10:30
    expect(at(19).deploy).toBe(1); // r2 finished 07:30
    expect(at(21).failure).toBe(1); // r4 finished 09:00
    expect(at(18).watchman).toBe(1); // drift note 06:00
    expect(at(23)).toEqual({ deploy: 0, destroy: 1, failure: 0, config: 1, firewall: 0, watchman: 1 });
    expect(at(0)).toEqual({ deploy: 0, destroy: 0, failure: 0, config: 0, firewall: 0, watchman: 0 });
  });

  it("uses 5 minute, 30 minute, 1 hour, 6 hour and 1 day steps", () => {
    const n = (r: "1h" | "6h" | "24h" | "7d" | "30d") => timeline([], r, NOW).length;
    expect([n("1h"), n("6h"), n("24h"), n("7d"), n("30d")]).toEqual([12, 12, 24, 28, 30]);
    expect(ACTIVITY_RANGE_MS["7d"]).toBe(7 * DAY);
  });

  it("leaves out events outside the range", () => {
    const tl = timeline(eventsOf(RUNS, NOTES, CHANGES), "1h", NOW);
    const total = tl.reduce((s, b) => s + Object.values(b.counts).reduce((a, c) => a + c, 0), 0);
    expect(total).toBe(3); // the 11:10 destroy, the 11:30 note, the 11:40 change
  });
});

describe("activityKpis", () => {
  it("counts only what happened inside the range", () => {
    const k = activityKpis(RUNS, NOTES, CHANGES, "24h", NOW);
    expect(k.deploys).toBe(2);
    expect(k.medianDeploySeconds).toBe(1500);
    expect(k.successRate).toEqual({ success: 3, finished: 4, pct: 75 });
    expect(k.failedRuns).toBe(1);
    expect(k.configChanges).toBe(2);
    expect(k.watchmanProblems).toBe(2);
    const week = activityKpis(RUNS, NOTES, CHANGES, "7d", NOW);
    expect(week.deploys).toBe(3);
    expect(week.medianDeploySeconds).toBe(1800);
    expect(week.configChanges).toBe(3);
  });

  it("says no data, not 0 %, when nothing finished", () => {
    const k = activityKpis([mkRun("q", "apply", "queued", MIN, null)], [], [], "24h", NOW);
    expect(k.successRate).toEqual({ success: 0, finished: 0, pct: null });
    expect(k.medianDeploySeconds).toBeNull();
    expect(k.deploys).toBe(0);
  });
});

describe("runRow", () => {
  it("has the run's facts and no secrets, with its source", async () => {
    const { env } = apiEnv();
    const cfg = await effectiveConfig(env);
    const row = runRow(RUNS[2], RUNS, cfg, NOW);
    expect(row.durationSeconds).toBe(1200);
    expect(row.sessionCostGbp).toBeGreaterThan(0);
    expect(row.source).toBe("dashboard");
    expect(runRow(mkRun("w", "apply", "success", HOUR, 1000, { requested_by: "watchman" }), [], cfg, NOW).source).toBe("watchman");
    expect(runRow(mkRun("s", "apply", "success", HOUR, 1000, { reason: "schedule" }), [], cfg, NOW).source).toBe("schedule");
    expect(runRow(RUNS[0], RUNS, cfg, NOW).durationSeconds).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/hunter2|CBHASH|AGHASH|PAYLOADSECRET/);
  });
});

async function seed(env: Env) {
  const nowMs = Date.now();
  const t = (ms: number) => new Date(nowMs - ms).toISOString();
  await db.createRun(env, { id: "run-a", action: "apply", status: "success", requested_at: t(2 * HOUR), requested_by: "steven", callback_token_hash: "CBHASH", agent_token_hash: "AGHASH", payload_json: '{"x":"PAYLOADSECRET"}', auto_destroy_at: null, reason: null, ssh_password: "hunter2-secret" });
  await db.updateRun(env, "run-a", { started_at: t(2 * HOUR), finished_at: t(HOUR) });
  await db.createRun(env, { id: "run-old", action: "apply", status: "success", requested_at: t(3 * DAY), requested_by: "steven", callback_token_hash: "CBHASH", agent_token_hash: "AGHASH", payload_json: null, auto_destroy_at: null, reason: null, ssh_password: null });
  await db.updateRun(env, "run-old", { started_at: t(3 * DAY), finished_at: t(3 * DAY - 600_000) });
  await env.DB.prepare("INSERT INTO alerts (at, kind, message) VALUES (?1, 'failure', 'bad thing')").bind(t(30 * MIN)).run();
  await env.DB.prepare("INSERT INTO alerts (at, kind, message) VALUES (?1, 'drift', 'old drift')").bind(t(3 * DAY)).run();
  await env.DB.prepare("INSERT INTO audit (at, user, action, target, before_json, after_json) VALUES (?1, 'steven', 'client.add', 'Phone', NULL, '{\"name\":\"Phone\"}')").bind(t(10 * MIN)).run();
}

describe("GET /activity", () => {
  it("answers for the default 24 hours with runs, notes, events, kpis and a timeline", async () => {
    const { env } = apiEnv();
    await seed(env);
    const r = await api(env, "GET", "/activity");
    expect(r.status).toBe(200);
    expect(r.json.range).toBe("24h");
    expect(r.json.runs.map((x: any) => x.id)).toEqual(["run-a"]);
    expect(r.json.notes.map((x: any) => x.message)).toEqual(["bad thing"]);
    expect(r.json.all.map((e: any) => e.type).sort()).toEqual(["config", "deploy", "watchman"]);
    expect(r.json.kpis.deploys).toBe(1);
    expect(r.json.kpis.watchmanProblems).toBe(1);
    expect(r.json.timeline).toHaveLength(24);
    expect(r.json.changes.rows[0].lines).toEqual(["name = Phone"]);
    const wide = await api(env, "GET", "/activity?range=7d");
    expect(wide.json.runs.map((x: any) => x.id).sort()).toEqual(["run-a", "run-old"]);
    expect(wide.json.timeline).toHaveLength(28);
  });

  it("carries no SSH password, token hash or run payload", async () => {
    const { env } = apiEnv();
    await seed(env);
    for (const path of ["/activity?range=30d", "/runs/run-a"]) {
      const r = await api(env, "GET", path);
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/hunter2|CBHASH|AGHASH|PAYLOADSECRET|ssh_password|payload_json|token_hash/);
    }
  });

  it("refuses a range it does not know, naming the field", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/activity?range=2d");
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("range");
  });

  it("says no data on an empty logbook", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/activity");
    expect(r.json.kpis.successRate.pct).toBeNull();
    expect(r.json.kpis.medianDeploySeconds).toBeNull();
    expect(r.json.runs).toEqual([]);
    expect(r.json.changes.rows).toEqual([]);
    expect(r.json.changes.more).toBe(false);
  });

  it("pages the change log 50 at a time and filters it by kind and search", async () => {
    const { env } = apiEnv();
    const base = Date.now();
    for (let i = 0; i < 55; i++) {
      await env.DB.prepare("INSERT INTO audit (at, user, action, target) VALUES (?1, 'steven', ?2, ?3)").bind(new Date(base - i * 1000).toISOString(), i < 5 ? "firewall.rule.add" : "client.add", `t${i}`).run();
    }
    const p1 = await api(env, "GET", "/activity");
    expect(p1.json.changes.rows).toHaveLength(50);
    expect(p1.json.changes.more).toBe(true);
    expect(p1.json.changes.page).toBe(1);
    const p2 = await api(env, "GET", "/activity?page=2");
    expect(p2.json.changes.rows).toHaveLength(5);
    expect(p2.json.changes.more).toBe(false);
    const fw = await api(env, "GET", "/activity?kind=firewall");
    expect(fw.json.changes.rows).toHaveLength(5);
    expect(fw.json.changes.kind).toBe("firewall");
    const odd = await api(env, "GET", "/activity?kind=nonsense");
    expect(odd.json.changes.kind).toBe("");
    expect(odd.json.changes.rows).toHaveLength(50);
    const q = await api(env, "GET", "/activity?q=t54");
    expect(q.json.changes.rows.map((x: any) => x.target)).toEqual(["t54"]);
    expect(q.json.changes.q).toBe("t54");
  });
});

describe("GET /runs/:id", () => {
  it("returns the run and its saved steps", async () => {
    const { env } = apiEnv();
    await seed(env);
    const steps = [{ name: "Terraform apply", status: "completed", conclusion: "success", started_at: null, completed_at: null }];
    await db.updateRun(env, "run-a", { steps_json: JSON.stringify(steps) });
    const r = await api(env, "GET", "/runs/run-a");
    expect(r.status).toBe(200);
    expect(r.json.run.id).toBe("run-a");
    expect(r.json.run.durationSeconds).toBe(3600);
    expect(r.json.steps).toEqual(steps);
    expect(r.json.active).toBe(false);
    expect((await api(env, "GET", "/runs/run-old")).json.steps).toEqual([]);
  });

  it("takes the steps from the snapshot while the run is the active one", async () => {
    const { env } = apiEnv();
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    const snap = await getSnapshot(env);
    snap.steps = [{ name: "Live step", status: "in_progress", conclusion: null }];
    await saveSnapshot(env, snap);
    const r = await api(env, "GET", `/runs/${run.id}`);
    expect(r.json.active).toBe(true);
    expect(r.json.steps.map((s: any) => s.name)).toEqual(["Live step"]);
  });

  it("is 404 for a run that does not exist", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/runs/nope")).status).toBe(404);
  });
});

describe("GET /runs/:id/log", () => {
  async function withGhRun(env: Env) {
    await seed(env);
    await db.updateRun(env, "run-a", { github_run_id: 5001 });
  }

  it("returns the first job's log", async () => {
    const { env, world } = apiEnv();
    await withGhRun(env);
    world.jobs.set(5001, [{ id: 77, name: "apply", status: "completed", conclusion: "success", steps: [] }]);
    world.logs.set(77, "2026-10-02T10:00:00.000Z first line\n2026-10-02T10:00:01.000Z second line");
    const r = await api(env, "GET", "/runs/run-a/log");
    expect(r.status).toBe(200);
    expect(r.json.log).toBe("first line\nsecond line");
  });

  it("is 404 no_log when there is no GitHub run, no jobs, or no log", async () => {
    const { env, world } = apiEnv();
    await seed(env);
    const none = await api(env, "GET", "/runs/run-a/log");
    expect(none.status).toBe(404);
    expect(none.json.error.code).toBe("no_log");
    await db.updateRun(env, "run-a", { github_run_id: 5001 });
    expect((await api(env, "GET", "/runs/run-a/log")).json.error.code).toBe("no_log"); // no jobs
    world.jobs.set(5001, [{ id: 77, name: "apply", status: "completed", conclusion: "success", steps: [] }]);
    const gone = await api(env, "GET", "/runs/run-a/log");
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe("no_log"); // job has no log
  });

  it("is 503 not_configured without GitHub, and 404 for a missing run", async () => {
    const { env } = apiEnv({ GITHUB_TOKEN: "REPLACE_ME" });
    await withGhRun(env);
    const r = await api(env, "GET", "/runs/run-a/log");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("not_configured");
    expect((await api(env, "GET", "/runs/nope/log")).status).toBe(404);
  });

  it("is 502 when GitHub cannot be reached", async () => {
    const { env, world } = apiEnv();
    await withGhRun(env);
    world.jobs.set(5001, [{ id: 77, name: "apply", status: "completed", conclusion: "success", steps: [] }]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/logs")) throw new Error("network down");
      return inner(input, init);
    });
    const r = await api(env, "GET", "/runs/run-a/log");
    expect(r.status).toBe(502);
  });
});
