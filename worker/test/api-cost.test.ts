// api-cost.test.ts
//
// Plain English: the Cost page's data: the month's window and the one
// before it, the end-of-month projection (and "no data" rather than a £0
// forecast), what each session cost, and the Standby note. Nothing secret
// is in the answer.
import { describe, it, expect } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { costWindow, projection, sessionsOf } from "../src/costview";
import { saveSnapshot } from "../src/state";
import * as db from "../src/db";
import type { CostDay, Run } from "../src/db";
import type { Config } from "../src/env";

const day = (d: string, gbp: number): CostDay => ({ day: d, gbp, fetched_at: "x" });
const cfg = { hourlyRateGbp: 0.5, region: "uksouth", vmSize: "Standard_B1s" } as Config;
const run = (id: string, action: "apply" | "destroy", finished: string | null, extra: Partial<Run> = {}): Run =>
  ({ id, action, status: "success", requested_at: finished ?? "2026-10-01T00:00:00Z", finished_at: finished, payload_json: null, ssh_password: null, ...extra }) as Run;

describe("costWindow", () => {
  it("month runs from the 1st to today, against the same days last month", () => {
    expect(costWindow("month", new Date("2026-10-15T09:00:00Z"))).toEqual({ from: "2026-10-01", to: "2026-10-15", prevFrom: "2026-09-01", prevTo: "2026-09-15" });
  });
  it("clamps the previous month's end when it is shorter", () => {
    expect(costWindow("month", new Date("2026-03-31T09:00:00Z"))).toEqual({ from: "2026-03-01", to: "2026-03-31", prevFrom: "2026-02-01", prevTo: "2026-02-28" });
  });
  it("7d and 30d are the last N days, then the N days before", () => {
    expect(costWindow("7d", new Date("2026-10-15T09:00:00Z"))).toEqual({ from: "2026-10-09", to: "2026-10-15", prevFrom: "2026-10-02", prevTo: "2026-10-08" });
    expect(costWindow("30d", new Date("2026-10-30T09:00:00Z"))).toEqual({ from: "2026-10-01", to: "2026-10-30", prevFrom: "2026-09-01", prevTo: "2026-09-30" });
  });
});

describe("projection", () => {
  it("scales the month so far to the whole month", () => {
    const p = projection([day("2026-10-01", 1), day("2026-10-02", 2), day("2026-10-03", 3), day("2026-09-30", 99)], new Date("2026-10-10T12:00:00Z"));
    // 6 pounds over the 3 days reported (the last is the 3rd), 31 days in October.
    expect(p!.gbp).toBeCloseTo(62, 6);
    expect(p!.basis).toMatch(/3 days/);
    expect(p!.basis).toMatch(/31/);
  });
  it("is null when this month has no Azure day yet", () => {
    expect(projection([], new Date("2026-10-10T12:00:00Z"))).toBeNull();
    expect(projection([day("2026-09-30", 5)], new Date("2026-10-10T12:00:00Z"))).toBeNull();
  });
});

describe("sessionsOf", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("ends a session at the next destroy, newest first, and marks the open one", () => {
    const runs = [
      run("a3", "apply", "2026-10-02T10:00:00Z", { payload_json: JSON.stringify({ region: "northeurope", vm_size: "Standard_B2s", ssh_allowed_cidr: "1.2.3.4/32" }), ssh_password: "hunter2" }),
      run("d2", "destroy", "2026-10-01T13:00:00Z"),
      run("a2", "apply", "2026-10-01T11:00:00Z"),
      run("bad", "apply", "2026-10-01T09:00:00Z", { status: "failure" }),
    ];
    const rows = sessionsOf(runs, cfg, now);
    expect(rows.map((r) => r.runId)).toEqual(["a3", "a2"]);
    expect(rows[0]).toMatchObject({ started: "2026-10-02T10:00:00Z", ended: null, durationSeconds: 7200, region: "northeurope", vmSize: "Standard_B2s", estimatedGbp: 1, perHourGbp: 0.5, stillRunning: true });
    expect(rows[1]).toMatchObject({ ended: "2026-10-01T13:00:00Z", durationSeconds: 7200, region: "uksouth", vmSize: "Standard_B1s", stillRunning: false });
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|1\.2\.3\.4|payload/);
  });
});

describe("GET /cost", () => {
  const month = new Date().toISOString().slice(0, 8);
  it("answers with no data as nulls and empty lists", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/cost");
    expect(r.status).toBe(200);
    expect(r.json.range).toBe("month");
    expect(r.json.meta).toMatchObject({ currency: "GBP", timezone: "UTC", azureLagHours: 24, asOfDay: null });
    expect(r.json).toMatchObject({ projection: null, daily: [], previous: [], sessions: [], standby: null, insights: [], monthToDate: 0 });
    expect(r.json.session).toEqual({ running: false, since: null, estimateGbp: null });
  });

  it("returns the window's days, month to date and a projection", async () => {
    const { env } = apiEnv();
    await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, 2, 'x')").bind(`${month}01`).run();
    await env.STATUS.put("cost:fetched_day", `${month}01`);
    const r = await api(env, "GET", "/cost?range=month");
    expect(r.json.daily.map((d: CostDay) => d.day)).toEqual([`${month}01`]);
    expect(r.json.monthToDate).toBe(2);
    expect(r.json.projection.gbp).toBeGreaterThan(0);
    expect(r.json.meta.asOfDay).toBe(`${month}01`);
  });

  it("explains Standby, from the data", async () => {
    const { env } = apiEnv();
    await saveSnapshot(env, { state: "standby", standby_since: new Date(Date.now() - 3_600_000).toISOString() });
    const r = await api(env, "GET", "/cost");
    expect(r.json.standby.perDayGbp).toBeCloseTo(r.json.meta.standbyRateGbp * 24, 6);
    expect(r.json.insights).toContain(`Standby costs about £${(r.json.meta.standbyRateGbp * 24).toFixed(2)} a day for the disk and address.`);
  });

  it("adds the budget sentence once it is at 80% or more", async () => {
    const { env } = apiEnv();
    await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, 25, 'x')").bind(`${month}01`).run();
    const r = await api(env, "GET", "/cost");
    expect(r.json.budget.level).toBe("over");
    expect(r.json.insights.some((s: string) => /budget/.test(s))).toBe(true);
  });

  it("under 80% of the budget: where the month is heading against the budget, and this month's sessions, as plain facts", async () => {
    const { env } = apiEnv();
    await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, 0.1, 'x')").bind(`${month}01`).run();
    await db.setSetting(env, "monthly_budget_gbp", "60");
    const at = `${month}01T09:00:00Z`;
    await db.createRun(env, { id: "run-b", action: "apply", status: "success", requested_at: at, requested_by: "dev@localhost", callback_token_hash: null, agent_token_hash: null, payload_json: null, auto_destroy_at: null, reason: null, ssh_password: null });
    await db.updateRun(env, "run-b", { finished_at: at });
    const r = await api(env, "GET", "/cost");
    expect(r.json.budget.level).toBe("ok");
    const days = Number(r.json.projection.basis.match(/all (\d+) days/)[1]);
    expect(r.json.insights).toContain(`At this pace the month ends at about £${(0.1 * days).toFixed(2)}, ${Math.round(((0.1 * days) / 60) * 100)}% of the £60.00 monthly budget.`);
    expect(r.json.insights.some((s: string) => /^1 session this month, about £\d+\.\d\d each\.$/.test(s)), r.json.insights.join(" | ")).toBe(true);
  });

  it("lists sessions with nothing secret in the serialised answer", async () => {
    const { env } = apiEnv();
    await db.createRun(env, { id: "run-a", action: "apply", status: "success", requested_at: "2026-10-01T10:00:00Z", requested_by: "dev@localhost", callback_token_hash: "cbhash-secret", agent_token_hash: "aghash-secret", payload_json: JSON.stringify({ region: "uksouth", ssh_allowed_cidr: "9.9.9.9/32" }), auto_destroy_at: null, reason: null, ssh_password: "hunter2-secret" });
    await db.updateRun(env, "run-a", { finished_at: "2026-10-01T10:02:00Z" });
    const r = await api(env, "GET", "/cost");
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0]).toMatchObject({ runId: "run-a", stillRunning: true, region: "uksouth" });
    expect(r.text).not.toMatch(/secret|9\.9\.9\.9|payload_json|ssh_password/);
  });

  it("refuses an unknown range", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/cost?range=year");
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("range");
  });
});
