// demo-outbound.test.ts
//
// Plain English: demo mode never calls the outside world (spec §9.2). With
// the everything story seeded into the demo store and the caller in demo
// mode, EVERY read route of the API (a table below maps each registered GET
// pattern to concrete addresses, using the demo's own ids, and every query
// variant the app sends), plus the firewall simulator and /health, is
// answered through the Worker's front door, and:
//   - nothing left the Worker (the harness's record of outside calls is empty),
//   - nothing even tried (the outbound guard refused nothing).
// A meta-test fails when a new GET route is registered without a row here.
//
// Also here: what the app is told about capabilities in demo (spec ruling
// 15), and that the outbound guard is a plain pass-through outside demo mode
// (a real request's fetch arrives untouched).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiEnv, api, base } from "./api-helpers";
import { TABLE, demoIds, registeredGets } from "./demo-routes";
import worker from "../src/index";
import { setDemo } from "../src/demo/switch";
import { seedScenario } from "../src/devseed";
import { installDemoFetchGuard, demoFetchGuarded, demoOutboundLog, demoScope } from "../src/demo/guard";
import { makeDemoEnv } from "../src/demo/env";
import { WriteMeter } from "../src/demo/sql";
import { sqliteLike } from "./harness";
import { canDispatch } from "../src/env";
import type { Env } from "../src/env";

const NOW = "2026-10-08T10:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the route table", () => {
  it("names every registered GET route (a new GET must be added here, and pass the no-outbound check)", () => {
    const gets = registeredGets();
    expect(gets).toHaveLength(31);
    expect(gets.filter((p) => !(p in TABLE))).toEqual([]);
    expect(Object.keys(TABLE).filter((p) => !gets.includes(p))).toEqual([]);
  });
});

describe("§9.2: no outside call in demo mode, on any read", () => {
  it("every GET route (every variant), the simulator and /health answer through the gate with nothing sent and nothing attempted", async () => {
    const { env, world } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    // Seed the demo (first read), then collect the demo's own ids.
    expect((await api(env, "GET", "/overview")).status).toBe(200);
    const ids = await demoIds(env);
    world.calls.length = 0;
    demoOutboundLog.length = 0;

    const answers: string[] = [];
    for (const [pattern, paths] of Object.entries(TABLE)) {
      for (const p of paths(ids)) {
        const r = await api(env, "GET", p);
        answers.push(`${r.status} ${p}`);
        expect(r.headers.get("X-WG-Data"), p).toBe("demo");
        // 2xx, or the route's own 4xx for a bad id or query; never a crash.
        expect(r.status, `${pattern} → ${p}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
        const head = await worker.fetch(new Request(`${base}/api/v1${p}`, { method: "HEAD" }), env, ctx);
        expect(head.status, `HEAD ${p}`).toBe(r.status);
      }
    }
    // The real seeded ids answer 2xx (the 4xx rows above are the deliberate bad ones).
    for (const p of [`/clients/${ids.peer}`, `/runs/${ids.run}`, `/runs/${ids.finishedRun}`, `/runs/${ids.labRun}`, `/runs/${ids.labRun}/log`, `/backup/config/${ids.day}`, `/labs/${ids.lab}`, `/labs/${ids.lab}/topology`, `/prefs/topology/${ids.lab}`]) {
      expect(answers, p).toContain(`200 ${p}`);
    }
    const sim = await api(env, "POST", "/firewall/simulate", { from: { kind: "any", value: null }, to: { kind: "any", value: null }, proto: "tcp", port: 443 });
    expect(sim.status).toBe(200);
    const health = await worker.fetch(new Request(`${base}/health`), env, ctx);
    expect(health.status).toBe(200);

    expect(world.calls).toEqual([]);
    expect(demoOutboundLog).toEqual([]);
  }, 300_000);
});

describe("spec ruling 15: what the app is told about capabilities in demo", () => {
  it("Overview's actions.canDispatch and Labs' autoCleanup are true, while the server's own canDispatch stays false", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const ov = await api(env, "GET", "/overview");
    expect(ov.json.actions.canDispatch).toBe(true);
    const labs = await api(env, "GET", "/labs");
    expect(labs.json.autoCleanup).toBe(true);
    const session = await api(env, "GET", "/session");
    expect(session.json.setupMissing).toEqual({});
    const settings = await api(env, "GET", "/settings");
    expect(settings.json.setup).toEqual([]);
    // No lab card in the demo says GitHub is missing.
    expect(JSON.stringify(labs.json)).not.toContain("GitHub is not connected");
    expect(canDispatch(makeDemoEnv({}, sqliteLike(), new WriteMeter()))).toBe(false);
  }, 60_000);

  it("a real environment without GitHub still says so (shaping is for the demo only)", async () => {
    const { env } = apiEnv({ GITHUB_TOKEN: undefined, GITHUB_REPO: undefined });
    const ov = await api(env, "GET", "/overview");
    expect(ov.json.actions.canDispatch).toBe(false);
    expect((await api(env, "GET", "/labs")).json.autoCleanup).toBe(false);
  });
});

describe("outside demo mode the outbound guard is a plain pass-through", () => {
  it("passes the very same arguments and answer through, and logs nothing", async () => {
    const answer = new Response("ok");
    const raw = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer);
    vi.stubGlobal("fetch", raw);
    installDemoFetchGuard();
    expect(demoFetchGuarded()).toBe(true);
    demoOutboundLog.length = 0;
    const req = new Request("https://api.github.com/repos/x");
    const init = { method: "POST", body: "{}" };
    const got = await globalThis.fetch(req, init);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][0]).toBe(req);
    expect(raw.mock.calls[0][1]).toBe(init);
    expect(got).toBe(answer);
    expect(demoOutboundLog).toEqual([]);
    // The same fetch inside demoScope is refused, so the guard is really there.
    await expect(demoScope.run(true, () => globalThis.fetch("https://api.github.com/x"))).rejects.toThrow(/Demo mode never calls/);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("a real-mode request that calls GitHub reaches it untouched", async () => {
    const { env, world } = apiEnv();
    installDemoFetchGuard();
    expect(demoFetchGuarded()).toBe(true);
    await seedScenario(env, "everything", new Date(NOW));
    const run = await env.DB.prepare("SELECT id FROM runs WHERE finished_at IS NOT NULL AND github_run_id IS NOT NULL ORDER BY requested_at DESC LIMIT 1").first<{ id: string }>();
    world.calls.length = 0;
    demoOutboundLog.length = 0;
    const r = await api(env, "GET", `/runs/${run!.id}/log`);
    expect(r.headers.get("X-WG-Data")).toBe("real");
    expect(world.calls.some((c) => c.host === "api.github.com")).toBe(true);
    expect(demoOutboundLog).toEqual([]);
  }, 60_000);
});
