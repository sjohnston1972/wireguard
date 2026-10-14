// AWS money: rates per cloud, the once-a-day Cost Explorer pull, one budget.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import { config, ratesFor, type Env } from "../src/env";
import * as db from "../src/db";
import { runScheduled } from "../src/monitor";
import { budgetStatus, budgetFigures } from "../src/budget";
import { getSnapshot, saveSnapshot } from "../src/state";
import { sessionsOf } from "../src/costview";
import { sessionSummary } from "../src/runs";
import { api, apiEnv } from "./api-helpers";
import type { Run } from "../src/db";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const NOW = "2026-10-14T12:00:00Z";

describe("ratesFor", () => {
  it("gives each cloud its own rates", () => {
    const cfg = config(env);
    expect(ratesFor(cfg, "azure")).toEqual({ hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp });
    expect(ratesFor(cfg, "aws")).toEqual({ hourlyRateGbp: 0.011, standbyRateGbp: 0.005 });
  });
});

describe("daily AWS actuals", () => {
  it("pulls once a day, converts to pounds, and counts in the one budget", async () => {
    vi.setSystemTime(new Date(NOW));
    world.awsCost = [{ day: "2026-10-13", usd: 2 }, { day: "2026-10-14", usd: 0.4 }];
    await runScheduled(env);
    await runScheduled(env);
    const ceCalls = world.calls.filter((c) => c.host === "ce.us-east-1.amazonaws.com");
    expect(ceCalls).toHaveLength(1);
    // End is today (exclusive): today's partial day is never asked for, even when Cost Explorer has one.
    // The zero days Cost Explorer also answers are not stored.
    expect(await db.awsCostDays(env, "2026-10-01")).toMatchObject([{ day: "2026-10-13", gbp: 1.5, usd: 2 }]);
    expect((await db.awsCostDays(env, "2026-10-01")).length).toBe(1);
    expect((await budgetStatus(env, undefined, undefined, new Date(NOW))).actual).toBeCloseTo(1.5, 6);
  });
  it("skips Cost Explorer when the Worker has no AWS keys", async () => {
    ({ env, world } = makeEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined }));
    await runScheduled(env);
    expect(world.calls.some((c) => c.host === "ce.us-east-1.amazonaws.com")).toBe(false);
  });
  it("zero-only Cost Explorer rows leave an Azure headend's Cost page unchanged", async () => {
    vi.setSystemTime(new Date(NOW));
    const costOf = async (e: Env) => {
      await db.upsertCostDay(e, "2026-10-01", 0.3);
      await db.upsertCostDay(e, "2026-10-02", 0.2);
      await runScheduled(e);
      const r = await api(e, "GET", "/cost");
      return { daily: r.json.daily.map((d: any) => [d.day, d.gbp]), projection: r.json.projection, byCloud: r.json.byCloud };
    };
    // The fetch stub belongs to the last env made, so build and run one at a time.
    const withKeys = apiEnv();
    const a = await costOf(withKeys.env);
    expect(withKeys.world.calls.some((c) => c.host === "ce.us-east-1.amazonaws.com")).toBe(true);
    const without = apiEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined });
    const b = await costOf(without.env);
    expect(a).toEqual(b);
    expect(a.byCloud.aws).toBe(0);
  });
  it("an AWS headend with billed days up to yesterday still counts today's hours", async () => {
    vi.setSystemTime(new Date(NOW));
    world.awsCost = [{ day: "2026-10-13", usd: 2 }];
    await runScheduled(env);
    const snap = { ...(await getSnapshot(env)), state: "running" as const, cloud: "aws" as const, running_since: "2026-10-12T00:00:00Z", auto_destroy_at: null };
    const b = await budgetStatus(env, undefined, snap, new Date(NOW));
    // From midnight today to noon: 12 hours at the AWS rate.
    expect(b.session).toBeCloseTo(12 * 0.011, 9);
  });
});

describe("budgetFigures for an AWS headend", () => {
  const snap = { state: "running" as const, running_since: "2026-10-03T00:00:00Z", auto_destroy_at: null };
  const base = { budget: 0, days: [{ day: "2026-10-12", gbp: 5 }], snap, hourlyRate: 0.011, now: new Date(NOW), cloud: "aws" as const };
  it("starts after the last AWS billed day, ignoring Azure's days", () => {
    const f = budgetFigures({ ...base, awsDays: [{ day: "2026-10-13", gbp: 1.5 }] });
    expect(f.session).toBeCloseTo(12 * 0.011, 9);
    expect(f.actual).toBeCloseTo(6.5, 9);
  });
  it("without AWS days falls back to the later of its start and the month start", () => {
    const f = budgetFigures({ ...base });
    // 3 Oct 00:00 to 14 Oct 12:00 = 11.5 days.
    expect(f.session).toBeCloseTo(11.5 * 24 * 0.011, 9);
  });
});

describe("the Cost page with two clouds", () => {
  it("sums a day's Azure and AWS figures and splits month to date by cloud", async () => {
    vi.setSystemTime(new Date(NOW));
    const t = apiEnv();
    await db.upsertCostDay(t.env, "2026-10-05", 0.4);
    await db.upsertAwsCostDay(t.env, "2026-10-05", 1.5, 2);
    await db.upsertAwsCostDay(t.env, "2026-10-06", 0.75, 1);
    const r = (await api(t.env, "GET", "/cost?range=month")).json;
    const day5 = r.daily.filter((d: any) => d.day === "2026-10-05");
    expect(day5).toHaveLength(1);
    expect(day5[0].gbp).toBeCloseTo(1.9, 9);
    expect(r.byCloud.aws).toBeCloseTo(2.25, 9);
    expect(r.byCloud.azure).toBeCloseTo(0.4, 9);
    expect(r.byCloud.azure + r.byCloud.aws).toBeCloseTo(r.monthToDate, 9);
  });
});

describe("a run in AWS is priced at the AWS rate", () => {
  const run = (cloud: boolean): Run =>
    ({ id: "r1", action: "apply", status: "success", requested_at: "2026-10-14T08:00:00Z", finished_at: "2026-10-14T10:00:00Z", payload_json: cloud ? JSON.stringify({ cloud: "aws" }) : null, ssh_password: null }) as Run;
  it("sessionsOf", () => {
    const cfg = config(env);
    const aws = sessionsOf([run(true)], cfg, new Date(NOW))[0];
    expect(aws.perHourGbp).toBe(0.011);
    expect(aws.estimatedGbp).toBeCloseTo(2 * 0.011, 9);
    expect(sessionsOf([run(false)], cfg, new Date(NOW))[0].perHourGbp).toBe(cfg.hourlyRateGbp);
  });
  it("sessionSummary follows the headend's cloud", async () => {
    await saveSnapshot(env, { cloud: "aws", state: "running", running_since: new Date(Date.now() - 10 * 3_600_000).toISOString() });
    expect(await sessionSummary(env, await getSnapshot(env), "Torn down")).toMatch(/about £0\.11\./);
  });
});
