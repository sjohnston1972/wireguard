// AWS money: rates per cloud, the once-a-day Cost Explorer pull, one budget.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import { config, ratesFor, type Env } from "../src/env";
import * as db from "../src/db";
import { runScheduled } from "../src/monitor";
import { budgetStatus } from "../src/budget";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

describe("ratesFor", () => {
  it("gives each cloud its own rates", () => {
    const cfg = config(env);
    expect(ratesFor(cfg, "azure")).toEqual({ hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp });
    expect(ratesFor(cfg, "aws")).toEqual({ hourlyRateGbp: 0.011, standbyRateGbp: 0.005 });
  });
});

describe("daily AWS actuals", () => {
  it("pulls once a day, converts to pounds, and counts in the one budget", async () => {
    const day = new Date().toISOString().slice(0, 10);
    world.awsCost = [{ day, usd: 2 }];
    await runScheduled(env);
    await runScheduled(env);
    const ceCalls = world.calls.filter((c) => c.host === "ce.us-east-1.amazonaws.com");
    expect(ceCalls).toHaveLength(1);
    expect(await db.awsCostDays(env, day)).toMatchObject([{ day, gbp: 1.5, usd: 2 }]);
    expect((await budgetStatus(env)).actual).toBeGreaterThanOrEqual(1.5);
  });
  it("skips Cost Explorer when the Worker has no AWS keys", async () => {
    ({ env, world } = makeEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined }));
    await runScheduled(env);
    expect(world.calls.some((c) => c.host === "ce.us-east-1.amazonaws.com")).toBe(false);
  });
});
