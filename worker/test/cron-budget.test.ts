// cron-budget.test.ts
//
// Plain English: the one */5 cron runs the gateway's watchman, then the lab
// watch, then the Azure insights collector, in ONE invocation, and Cloudflare's
// Free plan allows 50 outside calls per invocation. They share one allowance
// of CRON_CALLS (45), spent in priority order: the watchman first (counted,
// never refused), then the lab watch (its tear-downs first), then insights.
// What does not fit waits for the next run, five minutes on, still due.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBudget, BudgetExceeded } from "../src/insights/types";
import { runInsights, type FeedModule } from "../src/insights/runner";
import { runLabWatch, WATCH_CALLS } from "../src/labs/watch";
import { CRON_CALLS, runCron, type CronStages } from "../src/cron";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { advance, freeze, HOUR, labDispatches, labEnv, rows, runningLab } from "./labs-helpers";
import type { Env } from "../src/env";
import type { World } from "./harness";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A watchman that makes `n` outside calls through plain fetch, as the real one does from many modules. */
const watchmanOf = (n: number): CronStages["watchman"] => async () => {
  for (let i = 0; i < n; i++) await fetch(`https://cloudflare-dns.com/dns-query?watchman=${i}`);
  return [`made ${n} calls`];
};

/** Five insights feeds of 5 calls each (25, the collector's own cap). */
const FEEDS: FeedModule[] = ["health", "vmMetrics", "activity", "serviceHealth", "prices"].map((id) => ({
  id: id as FeedModule["id"],
  title: id,
  cadenceMin: 5,
  when: "always",
  calls: 5,
  arm: false,
  async run(ctx) {
    for (let i = 0; i < 5; i++) await ctx.fetch(`https://api.cloudflare.com/insights/${id}/${i}`);
    return { status: "ok", error: null };
  },
}));

function stages(watchmanCalls: number): CronStages {
  return {
    watchman: watchmanOf(watchmanCalls),
    labs: (env, now, parent) => runLabWatch(env, now, { parent }),
    insights: (env, now, parent) => runInsights(env, now, FEEDS, { parent }),
  };
}

/** Three labs past their timers, and the hourly orphan sweep and daily cost query due. */
async function expiredLabs(): Promise<{ env: Env; world: World }> {
  freeze();
  const { env, world } = await labEnv({ MONTHLY_BUDGET_GBP: "0" });
  for (const id of ["az104-05-storage", "az104-06-blob-security", "az104-07-files"]) await runningLab(env, world, id, { hours: 1, peer: false });
  advance(2 * HOUR);
  return { env, world };
}

const hostOf = (c: { host: string }) => c.host;
const feedRows = async (env: Env) => rows<{ feed: string; status: string; error: string | null; next_due_at: string | null }>(env, "SELECT feed, status, error, next_due_at FROM az_feed WHERE feed IN ('health','vmMetrics','activity','serviceHealth','prices') ORDER BY feed");

describe("one allowance for the */5 cron", () => {
  it("a budget with a parent spends from both and stops at whichever runs out first", () => {
    const parent = makeBudget(10);
    const a = makeBudget(8, parent);
    a.take(6);
    expect(parent.remaining()).toBe(4);
    expect(a.remaining()).toBe(2);
    const b = makeBudget(25, parent);
    expect(b.remaining()).toBe(4);
    expect(() => b.take(5)).toThrow(BudgetExceeded);
    expect(parent.used()).toBe(6); // a refused take takes nothing, from either
    b.take(4);
    expect(parent.remaining()).toBe(0);
    expect(() => a.take(1)).toThrow(BudgetExceeded);
    expect(CRON_CALLS).toBe(45);
  });

  it("never makes more than 45 calls: the watchman first, then the lab tear-downs, then the rest of the lab watch, then insights", async () => {
    const { env, world } = await expiredLabs();
    const before = world.calls.length;
    const out = await runCron(env, new Date(), stages(25));
    const calls = world.calls.slice(before);
    expect(calls.length).toBeLessThanOrEqual(CRON_CALLS);
    // The watchman is never refused.
    expect(calls.filter((c) => c.host === "cloudflare-dns.com")).toHaveLength(25);
    // The lab watch had what was left, at most its own 20, and its tear-downs went first.
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(3);
    const firstInsights = calls.findIndex((c) => c.host === "api.cloudflare.com");
    const lastLab = calls.map(hostOf).lastIndexOf("api.github.com");
    expect(lastLab).toBeGreaterThan(-1);
    if (firstInsights >= 0) expect(firstInsights).toBeGreaterThan(lastLab);
    // Insights had the rest: what did not fit is skipped and still due.
    const insightsCalls = calls.filter((c) => c.host === "api.cloudflare.com").length;
    expect(insightsCalls).toBe(Math.floor((CRON_CALLS - (calls.length - insightsCalls)) / 5) * 5);
    expect(insightsCalls).toBeLessThan(25); // the shared cap, not insights' own 25, stopped it
    const feeds = await feedRows(env);
    const skipped = feeds.filter((f) => f.status === "skipped");
    expect(skipped.length).toBe(5 - insightsCalls / 5);
    for (const f of skipped) {
      expect(f.error).toMatch(/calls/i);
      expect(f.next_due_at === null || Date.parse(f.next_due_at) <= Date.now()).toBe(true);
    }
    expect(out.used).toBe(calls.length);
  });

  it("a watchman that uses the whole allowance leaves the labs and insights for the next run, still due", async () => {
    const { env, world } = await expiredLabs();
    const before = world.calls.length;
    const out = await runCron(env, new Date(), stages(CRON_CALLS));
    const calls = world.calls.slice(before);
    expect(calls.filter((c) => c.host !== "cloudflare-dns.com")).toEqual([]);
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(0);
    expect(out.lines.join(" | ")).toMatch(/lab watch.*out of calls|deferred/i);
    expect((await feedRows(env)).every((f) => f.status === "skipped")).toBe(true);
    // Five minutes on, a quiet watchman: the tear-downs happen.
    advance(5 * 60_000);
    await runCron(env, new Date(), stages(0));
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(3);
  });

  it("the lab watch alone still keeps to its own 20", async () => {
    const { env, world } = await expiredLabs();
    const before = world.calls.length;
    await runCron(env, new Date(), { ...stages(0), insights: async () => [] });
    expect(world.calls.length - before).toBeLessThanOrEqual(WATCH_CALLS);
  });

  it("an orphan sweep that cannot afford its listings is not recorded, so it stays due", async () => {
    freeze();
    const { env } = await labEnv();
    const parent = makeBudget(3);
    const lines = await runLabWatch(env, new Date(), { parent });
    expect(lines.join(" | ")).toMatch(/orphans: out of calls/);
    expect(await env.STATUS.get("labs:sweep")).toBeNull();
    // With enough calls it runs and is recorded.
    await runLabWatch(env, new Date(), { parent: makeBudget(45) });
    expect(await env.STATUS.get("labs:sweep")).not.toBeNull();
  });
});
