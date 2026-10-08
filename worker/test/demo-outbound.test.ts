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
import { demoInstance } from "./harness";
import worker from "../src/index";
import { buildApi } from "../src/api";
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

/** The demo's own ids, read from the demo store's database. */
type Ids = { peer: number; run: string; finishedRun: string; labRun: string; lab: string; idleLab: string; day: string };

const RANGES = ["1h", "24h", "7d", "30d"];

/** Every registered GET pattern → the concrete addresses that exercise it (spec §9.2's table). */
const TABLE: Record<string, (ids: Ids) => string[]> = {
  "/session": () => ["/session"],
  "/overview": () => ["/overview"],
  "/ssh-password": () => ["/ssh-password"],
  "/history": (i) => [
    ...RANGES.map((r) => `/history?scope=vm&range=${r}`),
    ...RANGES.map((r) => `/history?scope=client&id=${i.peer}&range=${r}`),
    "/history?scope=rule&id=default&range=24h",
    "/history?scope=rule&id=r1&range=7d",
    "/history?scope=rule&id=f1&range=30d",
    "/history?scope=client&id=99999&range=24h",
    "/history?range=24h",
  ],
  "/clients": () => ["/clients"],
  "/clients/:id": (i) => [`/clients/${i.peer}`, "/clients/99999"],
  "/firewall": () => ["/firewall"],
  "/activity": () => ["/activity", ...["1h", "6h", "24h", "7d", "30d"].map((r) => `/activity?range=${r}`), "/activity?range=30d&kind=deploy", "/activity?range=30d&q=client&page=2"],
  "/runs/:id": (i) => [`/runs/${i.run}`, `/runs/${i.finishedRun}`, `/runs/${i.labRun}`, "/runs/no-such-run"],
  "/runs/:id/log": (i) => [`/runs/${i.run}/log`, `/runs/${i.finishedRun}/log`, `/runs/${i.labRun}/log`, "/runs/no-such-run/log"],
  "/cost": () => ["/cost", "/cost?range=month", "/cost?range=7d", "/cost?range=30d"],
  "/settings": () => ["/settings"],
  "/backup/export": () => ["/backup/export"],
  "/backup/config/:day": (i) => [`/backup/config/${i.day}`, "/backup/config/2001-01-01"],
  "/push/status": () => ["/push/status", "/push/status?endpoint=https%3A%2F%2Fpush.example.invalid%2Fx"],
  "/prefs": () => ["/prefs"],
  "/prefs/topology/:labId": (i) => [`/prefs/topology/${i.lab}`],
  "/azure/summary": () => ["/azure/summary"],
  "/azure/metrics": () => ["vm", "pip", "vitals"].flatMap((res) => RANGES.map((r) => `/azure/metrics?resource=${res}&range=${r}`)),
  "/azure/changes": () => ["/azure/changes", ...["24h", "7d", "30d", "90d"].flatMap((r) => ["all", "others", "wgadmin"].map((w) => `/azure/changes?range=${r}&who=${w}`))],
  "/azure/service-health": () => ["/azure/service-health", "/azure/service-health?range=7d", "/azure/service-health?range=90d"],
  "/azure/capacity": () => ["/azure/capacity?region=uksouth&size=Standard_B1s", "/azure/capacity?region=westeurope&size=Standard_B2s", "/azure/capacity"],
  "/azure/price": () => ["/azure/price?region=uksouth&size=Standard_B1s", "/azure/price?region=westeurope&size=Standard_B2s"],
  "/azure/diagnostics": () => ["/azure/diagnostics"],
  "/azure/bootlog": () => ["/azure/bootlog"],
  "/labs": () => ["/labs"],
  "/labs/sessions": (i) => ["/labs/sessions", `/labs/sessions?lab=${i.lab}&limit=5`],
  "/labs/coverage": () => ["/labs/coverage"],
  "/labs/:id": (i) => [`/labs/${i.lab}`, `/labs/${i.idleLab}`],
  "/labs/:id/topology": (i) => [`/labs/${i.lab}/topology`, `/labs/${i.idleLab}/topology`],
  "/labs/:id/secret": (i) => [`/labs/${i.lab}/secret`, `/labs/${i.idleLab}/secret`],
};

/** Every GET pattern registered on buildApi(), demo's own switch aside. */
function registeredGets(): string[] {
  return [...new Set(buildApi().routes.filter((r) => r.method === "GET" && r.path !== "/demo").map((r) => r.path))];
}

async function demoIds(env: Env): Promise<Ids> {
  const q = (sql: string) => demoInstance(env).state.sql.exec(sql).toArray();
  const settings = (await api(env, "GET", "/settings")).json;
  const running = q("SELECT lab_id FROM lab_sessions WHERE state = 'running' ORDER BY requested_at DESC LIMIT 1")[0];
  const labs = (await api(env, "GET", "/labs")).json;
  const lab = String(running?.lab_id ?? labs.labs[0].id);
  return {
    peer: Number(q("SELECT id FROM peers ORDER BY id LIMIT 1")[0].id),
    run: String(q("SELECT id FROM runs ORDER BY requested_at DESC LIMIT 1")[0].id),
    finishedRun: String(q("SELECT id FROM runs WHERE finished_at IS NOT NULL AND github_run_id IS NOT NULL ORDER BY requested_at DESC LIMIT 1")[0].id),
    labRun: String(q("SELECT id FROM lab_runs ORDER BY requested_at DESC LIMIT 1")[0].id),
    lab,
    idleLab: String(labs.labs.find((l: { id: string }) => l.id !== lab).id),
    day: String(settings.backups.config.days[0]),
  };
}

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
