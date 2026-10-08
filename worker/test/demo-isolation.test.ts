// demo-isolation.test.ts
//
// Plain English: demo mode stays out of the background and out of the real
// store's bookkeeping (spec §6.3, §9.7, §9.10):
//   - the cron (watchman, lab watch, insights collector) runs with the demo
//     store wired as a tripwire and never touches it, even while someone is
//     in demo mode; the scheduled() entry point the same;
//   - DEMO_STORE is named only in the four allowed places in the Worker's code;
//   - the dev seeder's wipe and the backup (export, nightly copy, restore)
//     never touch the demo_mode switch;
//   - the lab topology cache keeps demo and real answers apart.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, tripwire, tripped, sqliteLike } from "./harness";
import { apiEnv, api } from "./api-helpers";
import worker from "../src/index";
import { runCron } from "../src/cron";
import { seedScenario, SCENARIOS } from "../src/devseed";
import { buildExport, checkRestoreFile, applyRestore, nightlyConfigBackup, EXPORT_TABLES } from "../src/backup";
import { setDemo, demoOn } from "../src/demo/switch";
import { topologyCacheKey } from "../src/labs/topology";
import { makeDemoEnv } from "../src/demo/env";
import { WriteMeter } from "../src/demo/sql";
import { INSIGHTS_CRON } from "../src/insights/types";
import type { Env } from "../src/env";

const NOW = "2026-10-08T10:00:00.000Z";
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  tripped.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("§9.7: the background never touches the demo store", () => {
  it("runCron with DEMO_STORE as a tripwire, a running gateway and someone in demo mode, never touches it", async () => {
    const { env } = makeEnv();
    await seedScenario(env, "everything", new Date(NOW));
    await setDemo(env, "dev@localhost", true);
    env.DEMO_STORE = tripwire("DEMO_STORE");
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(Date.parse(NOW) + i * 300_000));
      await runCron(env, new Date());
    }
    expect(tripped).toEqual([]);
    // The cron acted on the real store, and left the switch alone.
    expect(await demoOn(env, "dev@localhost")).toBe(true);
  }, 120_000);

  it("the scheduled() entry point (both crons) never touches it", async () => {
    const { env } = makeEnv();
    await seedScenario(env, "running", new Date(NOW));
    env.DEMO_STORE = tripwire("DEMO_STORE");
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.parse(NOW), noRetry() {} } as ScheduledController, env, ctx);
    await worker.scheduled({ cron: INSIGHTS_CRON, scheduledTime: Date.parse(NOW) + 120_000, noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect(pending.length).toBe(2);
    expect(tripped).toEqual([]);
  }, 120_000);

  it("DEMO_STORE is named only in worker/src/demo/**, index.ts, env.ts and api/demo.ts", () => {
    const allowed = (p: string) => p.startsWith("demo/") || p === "index.ts" || p === "env.ts" || p === "api/demo.ts";
    const named = walk(SRC).filter((f) => readFileSync(f, "utf8").includes("DEMO_STORE")).map(rel);
    expect(named.filter((p) => !allowed(p))).toEqual([]);
    // And it is really used where the gate is (so this scan is looking at the right files).
    expect(named).toContain("demo/gate.ts");
  });

  it("no background module reaches the demo store's code or the gate", () => {
    const background = walk(SRC).map(rel).filter((p) => ["cron.ts", "monitor.ts", "backup.ts", "labs/watch.ts", "actions.ts", "notify.ts", "webpush.ts"].includes(p) || p.startsWith("insights/"));
    expect(background.length).toBeGreaterThan(5);
    for (const p of background) {
      const src = readFileSync(join(SRC, p), "utf8");
      expect(src, p).not.toMatch(/demo\/(store|gate|switch)/);
      expect(src, p).not.toContain("demo_mode");
    }
  });
});

describe("§9.7: the dev seeder and the backup never touch demo_mode", () => {
  it("every dev seed story leaves the switch rows alone", async () => {
    const { env } = makeEnv();
    await setDemo(env, "dev@localhost", true);
    await setDemo(env, "someone@example.com", true);
    for (const s of SCENARIOS) await seedScenario(env, s, new Date(NOW));
    const rows = (await env.DB.prepare("SELECT user FROM demo_mode ORDER BY user").all<{ user: string }>()).results.map((r) => r.user);
    expect(rows).toEqual(["dev@localhost", "someone@example.com"]);
  }, 300_000);

  it("the export (and the nightly copy) never carries demo_mode; a restore leaves it alone", async () => {
    const { env } = makeEnv();
    await seedScenario(env, "everything", new Date(NOW));
    await setDemo(env, "someone@example.com", true);
    expect(Object.values(EXPORT_TABLES)).not.toContain("demo_mode");
    const exp = await buildExport(env, new Date(NOW));
    const text = JSON.stringify(exp);
    expect(text).not.toContain("demo_mode");
    expect(text).not.toContain("someone@example.com");
    await env.STATUS.delete("config-backup:day");
    expect(await nightlyConfigBackup(env, new Date(NOW))).toMatch(/written/);
    const nightly = await env.STATE.get(`config-backups/${NOW.slice(0, 10)}.json`);
    expect(await nightly!.text()).not.toContain("demo_mode");
    const plan = await checkRestoreFile(env, text);
    expect(typeof plan).not.toBe("string");
    await applyRestore(env, plan as Exclude<typeof plan, string>);
    expect(await demoOn(env, "someone@example.com")).toBe(true);
  }, 120_000);

  it("the restore route, called while someone is in demo mode, leaves their switch alone", async () => {
    const { env } = apiEnv();
    await setDemo(env, "someone@example.com", true);
    const exp = (await api(env, "GET", "/backup/export")).json;
    expect(JSON.stringify(exp)).not.toContain("demo_mode");
    const preview = await api(env, "POST", "/backup/restore/preview", exp);
    expect(preview.status).toBeLessThan(500);
    expect(await demoOn(env, "someone@example.com")).toBe(true);
  });
});

describe("§9.10: the lab topology cache keeps demo and real apart", () => {
  it("keys start with the data source", () => {
    const { env } = makeEnv();
    const demo = makeDemoEnv(env as unknown as Record<string, unknown>, sqliteLike(), new WriteMeter());
    expect(topologyCacheKey(env, "az104-01", "ls-1")).toBe("real:az104-01:ls-1");
    expect(topologyCacheKey(demo, "az104-01", "ls-1")).toBe("demo:az104-01:ls-1");
    expect(topologyCacheKey({ ...demo } as Env, "az104-01", "ls-1")).toBe("demo:az104-01:ls-1");
    expect(topologyCacheKey(demo, "az104-01", "ls-1")).not.toBe(topologyCacheKey(env, "az104-01", "ls-1"));
  });
});
