// insights-runner.test.ts
//
// Plain English: the collector's runner (plan X1.1). It runs the feeds that
// are due, in priority order, under one budget of 25 outside calls; one
// feed failing, hanging or running out of budget never stops the others;
// without credentials nothing is fetched at all.
import { describe, it, expect, afterEach, vi } from "vitest";
import { runInsights, FEED_MODULES, whenHolds, type FeedModule } from "../src/insights/runner";
import { BudgetExceeded, AZ_RUN_BUDGET, FEED_IDS } from "../src/insights/types";
import { EMPTY, type Snapshot } from "../src/state";
import { azureEnv, running, feedRows, setFeed, allNotDue, NOW, ago, iso, MIN, NO_AZURE, callsTo, FAKE_TOKEN } from "./insights-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A stand-in feed: records that it ran, then does `body`. */
function fake(id: FeedModule["id"], log: string[], over: Partial<FeedModule> = {}, body?: (ctx: any) => Promise<void>): FeedModule {
  return {
    id,
    title: id,
    cadenceMin: 5,
    when: "always",
    calls: 1,
    arm: false,
    ...over,
    async run(ctx) {
      log.push(id);
      if (body) await body(ctx);
      return { status: "ok", error: null };
    },
  };
}

describe("the runner", () => {
  it("runner runs due feeds in priority order and records last_ok_at", async () => {
    const { env } = azureEnv();
    const log: string[] = [];
    await setFeed(env, "vmMetrics", { status: "ok", next_due_at: iso(NOW.getTime() + 3 * MIN) });
    await setFeed(env, "activity", { status: "ok", next_due_at: ago(1) });
    const feeds = [fake("health", log), fake("vmMetrics", log), fake("activity", log, { cadenceMin: 60 }), fake("serviceHealth", log, { cadenceMin: 15 })];
    await runInsights(env, NOW, feeds);
    expect(log).toEqual(["health", "activity", "serviceHealth"]);
    const rows = await feedRows(env);
    expect(rows.health).toMatchObject({ status: "ok", last_ok_at: NOW.toISOString(), last_try_at: NOW.toISOString(), error: null, next_due_at: iso(NOW.getTime() + 5 * MIN) });
    expect(rows.activity.next_due_at).toBe(iso(NOW.getTime() + 60 * MIN));
    expect(rows.serviceHealth.next_due_at).toBe(iso(NOW.getTime() + 15 * MIN));
    // Not due: untouched.
    expect(rows.vmMetrics.next_due_at).toBe(iso(NOW.getTime() + 3 * MIN));
    // The registry is in the spec's priority order, housekeeping last.
    expect(FEED_MODULES.map((f) => f.id)).toEqual([...FEED_IDS, "housekeeping"]);
  });

  it("a feed that throws is recorded as error and the next feed still runs", async () => {
    const { env } = azureEnv();
    const log: string[] = [];
    await setFeed(env, "health", { status: "ok", last_ok_at: ago(5) });
    const feeds = [
      fake("health", log, {}, async () => {
        throw new Error("Azure said 500 at https://management.azure.com/subscriptions/x?sig=abc");
      }),
      fake("vmMetrics", log),
    ];
    const lines = await runInsights(env, NOW, feeds);
    expect(log).toEqual(["health", "vmMetrics"]);
    const rows = await feedRows(env);
    expect(rows.health.status).toBe("error");
    expect(rows.health.error).toMatch(/Azure said 500/);
    expect(rows.health.error).not.toMatch(/https?:|sig=/);
    expect(rows.health.last_ok_at).toBe(ago(5));
    expect(rows.health.next_due_at).toBe(iso(NOW.getTime() + 5 * MIN));
    expect(rows.vmMetrics.status).toBe("ok");
    expect(lines.join(" ")).toMatch(/health/);
  });

  it("a feed whose calls would pass the budget is skipped and stays due", async () => {
    const { env } = azureEnv();
    const log: string[] = [];
    await setFeed(env, "pipMetrics", { status: "ok", next_due_at: ago(3) });
    const feeds = [
      fake("health", log, { calls: 20 }, async (ctx) => ctx.budget.take(20)),
      fake("vmMetrics", log, { calls: 3 }, async (ctx) => {
        ctx.budget.take(3);
        ctx.budget.take(5); // more than it said: ends this feed only
      }),
      fake("pipMetrics", log, { calls: 6 }),
      fake("activity", log, { calls: 2 }),
    ];
    await runInsights(env, NOW, feeds);
    expect(log).toEqual(["health", "vmMetrics", "activity"]);
    const rows = await feedRows(env);
    expect(rows.pipMetrics.status).toBe("skipped");
    expect(rows.pipMetrics.next_due_at).toBe(ago(3));
    expect(rows.vmMetrics.status).toBe("skipped");
    expect(rows.vmMetrics.next_due_at).toBeNull();
    expect(rows.activity.status).toBe("ok");
    // Next run: the skipped feeds are still due.
    log.length = 0;
    await runInsights(env, new Date(NOW.getTime() + 1 * MIN), feeds.slice(2));
    expect(log).toEqual(["pipMetrics"]);
  });

  it("budget.take throws BudgetExceeded past 25", async () => {
    const { env, az } = azureEnv();
    let caught: unknown = null;
    const feeds = [
      fake("health", [], { arm: true }, async (ctx) => {
        try {
          for (let i = 0; i < 40; i++) await ctx.arm(`/subscriptions/s/resourceGroups/rg/x${i}?api-version=1`);
        } catch (e) {
          caught = e;
          throw e;
        }
      }),
    ];
    await runInsights(env, NOW, feeds);
    expect(caught).toBeInstanceOf(BudgetExceeded);
    expect(az.calls.length).toBe(AZ_RUN_BUDGET); // the sign-in plus 24 ARM calls
    expect((await feedRows(env)).health.status).toBe("skipped");
  });

  it("worst-case run makes at most 25 fetches", async () => {
    // Stand-in feeds that each make as many calls as they declare, 33 in all
    // (the real feeds' worst case is in api-azure.test.ts).
    const { env, az } = azureEnv();
    const calling = (id: FeedModule["id"], declared: number, arm: boolean, makes = declared) =>
      fake(id, [], { calls: declared, arm }, async (ctx) => {
        for (let i = 0; i < makes; i++) await (arm ? ctx.arm(`/subscriptions/s/${id}/${i}?api-version=1`) : ctx.fetch(`https://prices.azure.com/api/retail/prices?i=${i}`));
      });
    // bootLog says 3 but tries 12: it is stopped at the budget, and housekeeping after it is skipped.
    const feeds = [calling("health", 2, true), calling("vmMetrics", 1, true), calling("pipMetrics", 1, true), calling("metricDefs", 2, true), calling("activity", 2, true), calling("serviceHealth", 1, true), calling("capacity", 2, true), calling("prices", 3, false), calling("bootLog", 3, true, 12), calling("housekeeping", 1, true)];
    await runInsights(env, NOW, feeds);
    expect(az.calls.length).toBe(AZ_RUN_BUDGET);
    const rows = await feedRows(env);
    expect(rows.bootLog.status).toBe("skipped");
    expect(rows.housekeeping.status).toBe("skipped");
  });

  it("sign-in failure marks ARM feeds error and still runs prices", async () => {
    const { env, az } = azureEnv();
    az.loginStatus = 401;
    const log: string[] = [];
    const feeds = [
      fake("health", log, { arm: true }, async (ctx) => void (await ctx.arm("/subscriptions/s/x?api-version=1"))),
      fake("activity", log, { arm: true }),
      fake("prices", log, { arm: false }, async (ctx) => void (await ctx.fetch("https://prices.azure.com/api/retail/prices"))),
    ];
    await runInsights(env, NOW, feeds);
    const rows = await feedRows(env);
    for (const id of ["health", "activity"]) {
      expect(rows[id]?.status, id).toBe("error");
      expect(rows[id]?.error, id).toMatch(/sign-in/i);
    }
    expect(log).toEqual(["prices"]);
    expect(rows.prices.status).toBe("ok");
    // One sign-in attempt, not one per feed; nothing sent to ARM.
    expect(callsTo(az, "login.microsoftonline.com").length).toBe(1);
    expect(callsTo(az, "management.azure.com").length).toBe(0);
  });

  it("without credentials every feed is not_configured and nothing is fetched", async () => {
    const { env, az } = azureEnv(NO_AZURE);
    await running(env);
    await runInsights(env, NOW);
    expect(az.calls).toEqual([]);
    const rows = await feedRows(env);
    for (const id of FEED_IDS) expect(rows[id]?.status, id).toBe("not_configured");
    // A second run writes nothing new (no D1 churn every 5 minutes).
    const before = JSON.stringify(rows);
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    expect(JSON.stringify(await feedRows(env))).toBe(before);
  });

  it("a fetch that hangs is aborted at 8 s and ends that feed only", async () => {
    const { env, az } = azureEnv();
    await env.STATUS.put("azure:token", JSON.stringify({ token: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 }));
    let aborted = false;
    az.handlers.push((c) => (c.url.includes("/hang") ? new Promise<Response>(() => {}) : undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const log: string[] = [];
    const feeds = [
      fake("health", log, { arm: true }, async (ctx) => {
        try {
          await ctx.arm("/subscriptions/s/hang?api-version=1");
        } catch (e) {
          aborted = true;
          throw e;
        }
      }),
      fake("vmMetrics", log),
    ];
    const run = runInsights(env, NOW, feeds);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(log).toEqual(["health"]);
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(aborted).toBe(true);
    expect(log).toEqual(["health", "vmMetrics"]);
    const rows = await feedRows(env);
    expect(rows.health.status).toBe("error");
    expect(rows.health.error).toMatch(/8 s/);
    expect(rows.vmMetrics.status).toBe("ok");
  });

  it("when conditions: rg, vm, running, always", () => {
    const now = NOW.getTime();
    const snap = (over: Partial<Snapshot>): Snapshot => ({ ...EMPTY, ...over });
    const destroyed = snap({ state: "destroyed", since: ago(60) });
    const runningSnap = snap({ state: "running", since: ago(60), running_since: ago(60) });
    const standby = snap({ state: "standby", since: ago(5) });
    const standbyLong = snap({ state: "standby", since: ago(30) });
    const deploying = snap({ state: "deploying", since: ago(2) });
    const failedWithRg = snap({ state: "failed", since: ago(2), azure: { checked_at: ago(1), resource_group: "rg", exists: true, resources: [] } });
    const failedNoRg = snap({ state: "failed", since: ago(2), azure: { checked_at: ago(1), resource_group: "rg", exists: false, resources: [] } });

    for (const s of [destroyed, runningSnap, standby, deploying]) expect(whenHolds("always", s, now)).toBe(true);

    expect(whenHolds("rg", destroyed, now)).toBe(false);
    expect(whenHolds("rg", runningSnap, now)).toBe(true);
    expect(whenHolds("rg", deploying, now)).toBe(true);
    expect(whenHolds("rg", failedWithRg, now)).toBe(true);
    expect(whenHolds("rg", failedNoRg, now)).toBe(false);

    expect(whenHolds("vm", destroyed, now)).toBe(false);
    expect(whenHolds("vm", runningSnap, now)).toBe(true);
    expect(whenHolds("vm", standby, now)).toBe(true);
    expect(whenHolds("vm", deploying, now)).toBe(false);

    expect(whenHolds("running", runningSnap, now)).toBe(true);
    expect(whenHolds("running", standby, now)).toBe(true); // stopped 5 minutes ago: the last slots still come in
    expect(whenHolds("running", standbyLong, now)).toBe(false);
    expect(whenHolds("running", destroyed, now)).toBe(false);
  });
});
