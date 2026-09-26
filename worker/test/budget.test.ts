// The monthly budget (issue #44): the sum, the 80% and 100% alerts (once
// each a month, not every 5 minutes), and Deploy's "are you sure?" when over.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { budgetFigures, budgetStatus, checkBudget } from "../src/budget";
import { effectiveConfig } from "../src/settings";
import { runScheduled } from "../src/monitor";
import { saveSnapshot } from "../src/state";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const idle = { state: "destroyed" as const, running_since: null, auto_destroy_at: null };

describe("the sum", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  it("no budget (0) means no level at all", () => {
    const f = budgetFigures({ budget: 0, days: [{ day: "2026-09-01", gbp: 50 }], snap: idle, hourlyRate: 1, now });
    expect(f.level).toBe("none");
    expect(f.pct).toBe(0);
  });

  it("adds this month's actual spend, ignoring other months", () => {
    const f = budgetFigures({ budget: 10, days: [{ day: "2026-08-31", gbp: 99 }, { day: "2026-09-01", gbp: 3 }, { day: "2026-09-02", gbp: 5 }], snap: idle, hourlyRate: 1, now });
    expect(f.actual).toBe(8);
    expect(f.pct).toBeCloseTo(80);
    expect(f.level).toBe("warn");
  });

  it("counts the running VM to its timer, from where Azure's figures stop", () => {
    // Azure has listed up to the 19th; the VM came up on the 19th at 22:00 and
    // its timer ends at 16:00 on the 20th. Only the 16 hours from midnight count.
    const snap = { state: "running" as const, running_since: "2026-09-19T22:00:00Z", auto_destroy_at: "2026-09-20T16:00:00Z" };
    const f = budgetFigures({ budget: 100, days: [{ day: "2026-09-19", gbp: 1 }], snap, hourlyRate: 0.5, now });
    expect(f.session).toBeCloseTo(8);
    expect(f.total).toBeCloseTo(9);
  });

  it("with no timer, counts the session up to now; never past the month's end", () => {
    const snap = { state: "running" as const, running_since: "2026-09-20T10:00:00Z", auto_destroy_at: null };
    expect(budgetFigures({ budget: 100, days: [], snap, hourlyRate: 1, now }).session).toBeCloseTo(2);
    const late = { state: "running" as const, running_since: "2026-09-30T22:00:00Z", auto_destroy_at: "2026-10-01T04:00:00Z" };
    expect(budgetFigures({ budget: 100, days: [], snap: late, hourlyRate: 1, now: new Date("2026-09-30T23:00:00Z") }).session).toBeCloseTo(2);
  });

  it("at 100% or more it is over", () => {
    expect(budgetFigures({ budget: 10, days: [{ day: "2026-09-05", gbp: 10 }], snap: idle, hourlyRate: 1, now }).level).toBe("over");
  });
});

describe("the watchman's alerts", () => {
  let env: Env;
  let world: World;
  beforeEach(() => {
    ({ env, world } = makeEnv());
  });
  afterEach(() => vi.unstubAllGlobals());

  const now = new Date("2026-09-20T12:00:00Z");
  const budgetNotes = () => world.notes.filter((n) => /budget/.test(n.title));

  it("sends 80% once, then 100% once, however many times it runs", async () => {
    const cfg = await effectiveConfig(env); // budget £10 in the harness
    await db.upsertCostDay(env, "2026-09-01", 5);
    expect(await checkBudget(env, cfg, now)).toBeNull();

    await db.upsertCostDay(env, "2026-09-02", 3.5); // 85%
    expect(await checkBudget(env, cfg, now)).toMatch(/80%/);
    expect(await checkBudget(env, cfg, now)).toBeNull();
    expect(budgetNotes()).toHaveLength(1);
    expect(budgetNotes()[0].title).toMatch(/80%/);

    await db.upsertCostDay(env, "2026-09-03", 2); // 105%
    expect(await checkBudget(env, cfg, now)).toMatch(/100%/);
    expect(await checkBudget(env, cfg, now)).toBeNull();
    expect(budgetNotes()).toHaveLength(2);
    expect(budgetNotes()[1].title).toMatch(/over budget/);
    expect((await db.listAlerts(env)).filter((a) => a.kind === "budget")).toHaveLength(2);
    expect((await budgetStatus(env, cfg, undefined, now)).alerted).toBe(100);
  });

  it("jumping straight past 100% sends only the 100% alert", async () => {
    const cfg = await effectiveConfig(env);
    await db.upsertCostDay(env, "2026-09-01", 12);
    await checkBudget(env, cfg, now);
    await checkBudget(env, cfg, now);
    expect(budgetNotes().map((n) => n.title)).toEqual(["wg-admin: over budget"]);
  });

  it("starts afresh in a new month", async () => {
    const cfg = await effectiveConfig(env);
    await db.upsertCostDay(env, "2026-09-01", 12);
    await checkBudget(env, cfg, now);
    await db.upsertCostDay(env, "2026-10-01", 9);
    expect(await checkBudget(env, cfg, new Date("2026-10-02T12:00:00Z"))).toMatch(/80%/);
    expect(budgetNotes()).toHaveLength(2);
  });

  it("does nothing with no budget set", async () => {
    await db.setSetting(env, "monthly_budget_gbp", "0");
    const cfg = await effectiveConfig(env);
    await db.upsertCostDay(env, "2026-09-01", 500);
    expect(await checkBudget(env, cfg, now)).toBeNull();
    expect(budgetNotes()).toHaveLength(0);
  });

  it("is part of the 5-minute watchman run", async () => {
    const today = new Date();
    await db.upsertCostDay(env, today.toISOString().slice(0, 10), 11);
    const notes = await runScheduled(env, today);
    expect(notes).toContain("budget: 100% alert sent");
    expect((await runScheduled(env, today)).some((n) => /^budget/.test(n))).toBe(false);
  });
});

describe("Deploy when over budget", () => {
  let env: Env;
  let world: World;
  beforeEach(async () => {
    ({ env, world } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" }));
    await db.upsertCostDay(env, new Date().toISOString().slice(0, 7) + "-01", 25); // £25 of £10
  });
  afterEach(() => vi.unstubAllGlobals());

  const deploy = (fields: Record<string, string>) =>
    worker.fetch(new Request("http://localhost:8787/actions/deploy", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "HX-Request": "true", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }), env, ctx) as Promise<Response>;
  const page = async (path: string) => (await (worker.fetch(new Request(`http://localhost:8787${path}`), env, ctx) as Promise<Response>)).text();

  it("is refused by the Worker without the tick, whatever the browser does", async () => {
    const body = await (await deploy({ hours: "2" })).text();
    expect(body).toMatch(/of the £10.00 budget. Tick .*to go ahead/);
    expect(world.dispatches).toHaveLength(0);
  });

  it("goes ahead with the tick", async () => {
    const body = await (await deploy({ hours: "2", over_budget_ok: "yes" })).text();
    expect(body).toMatch(/Deploy started/);
    expect(world.dispatches).toHaveLength(1);
  });

  it("under budget, no tick is needed", async () => {
    await db.setSetting(env, "monthly_budget_gbp", "100");
    await deploy({ hours: "2" });
    expect(world.dispatches).toHaveLength(1);
  });

  it("the dashboard shows why and the tick box; the Cost page says over budget", async () => {
    const dash = await page("/");
    expect(dash).toMatch(/name="over_budget_ok"/);
    expect(dash).toMatch(/250%/);
    const cost = await page("/cost");
    expect(cost).toMatch(/Over budget/);
    await db.setSetting(env, "monthly_budget_gbp", "0");
    expect(await page("/")).not.toMatch(/over_budget_ok/);
    expect(await page("/cost")).toMatch(/No monthly budget set/);
  });

  it("the running session counts towards it on the Cost page", async () => {
    await env.DB.prepare("DELETE FROM cost_days").run();
    await saveSnapshot(env, { state: "running", running_since: new Date(Date.now() - 3_600_000).toISOString(), auto_destroy_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await page("/cost")).toMatch(/counting about £0\.0\d\d more for this session/);
  });
});
