// demo-journey.test.ts
//
// Plain English: the whole demo journey leaves the real setup exactly as it
// was (spec §9.4). A running gateway with its clients, runs and history is
// fingerprinted (every D1 table's rows, every KV key and value, every R2 key,
// every RunLock instance's storage). Then: switch demo mode on (which seeds
// the demo store), read every page, try every action, refresh the demo data,
// switch off. The fingerprint afterwards equals the one before; while demo
// mode was on, the only difference was the caller's demo_mode row. Nothing
// left the Worker at any point.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiEnv, api, base } from "./api-helpers";
import { fingerprint } from "./harness";
import { TABLE, demoIds } from "./demo-routes";
import worker from "../src/index";
import { buildApi } from "../src/api";
import { seedScenario } from "../src/devseed";
import { demoOutboundLog } from "../src/demo/guard";
import { DEMO_MIN_INTERVAL_MS } from "../src/demo/store";
import { DEMO_CONTROL, DEMO_REFUSED_MESSAGE } from "../../shared/demo";

const NOW = "2026-10-08T10:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "1");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("§9.4: the real setup is untouched by the whole journey", () => {
  it("enable (seeds), every GET, every refusal, refresh, disable: the real fingerprint is unchanged apart from the demo_mode row while on", async () => {
    const { env, world } = apiEnv();
    await seedScenario(env, "running", new Date(NOW));
    const realClients = (await api(env, "GET", "/clients")).json.clients.length;
    world.calls.length = 0;
    demoOutboundLog.length = 0;
    const before = await fingerprint(env);
    expect(before.d1.demo_mode).toEqual([]);

    // Enable: seeds the demo store, writes only the switch row.
    const on = await api(env, "PUT", "/demo", { on: true });
    expect(on.status).toBe(200);
    expect(on.json.refreshedAt).toBe(NOW);
    const during = await fingerprint(env);
    expect(during.d1.demo_mode).toEqual([JSON.stringify({ user: "dev@localhost", since: NOW })]);
    expect({ ...during, d1: { ...during.d1, demo_mode: [] } }).toEqual(before);

    // Every read, from the demo.
    const ids = await demoIds(env);
    for (const paths of Object.values(TABLE)) {
      for (const p of paths(ids)) {
        const r = await api(env, "GET", p);
        expect(r.status, p).toBeLessThan(500);
        expect(r.headers.get("X-WG-Data"), p).toBe("demo");
      }
    }
    expect((await api(env, "POST", "/firewall/simulate", { from: { kind: "any", value: null }, to: { kind: "any", value: null }, proto: "tcp", port: 22 })).status).toBe(200);
    expect((await worker.fetch(new Request(`${base}/health`), env, ctx)).headers.get("X-WG-Data")).toBe("demo");

    // Every action, refused.
    const actions = buildApi().routes.filter((r) => r.method !== "ALL" && r.method !== "GET" && !DEMO_CONTROL.some((c) => c.method === r.method && c.path === r.path) && r.path !== "/firewall/simulate");
    expect(actions.length).toBeGreaterThanOrEqual(58);
    for (const a of actions) {
      const r = await api(env, a.method, concrete(a.path), {});
      expect(r.status, `${a.method} ${a.path}`).toBe(409);
      expect(r.json).toEqual({ error: { code: "demo_mode", message: DEMO_REFUSED_MESSAGE } });
    }

    // Refresh (after the 10-minute interval), then switch off.
    vi.setSystemTime(new Date(Date.parse(NOW) + DEMO_MIN_INTERVAL_MS));
    expect((await api(env, "POST", "/demo/refresh")).status).toBe(200);
    const off = await api(env, "PUT", "/demo", { on: false });
    expect(off.status).toBe(200);
    expect(off.headers.get("X-WG-Data")).toBe("real");

    // Real data straight back, and the real stores exactly as they were.
    const back = await api(env, "GET", "/clients");
    expect(back.headers.get("X-WG-Data")).toBe("real");
    expect(back.json.clients.length).toBe(realClients);
    expect(await fingerprint(env)).toEqual(before);
    expect(world.calls).toEqual([]);
    expect(world.dispatches).toEqual([]);
    expect(world.notes).toEqual([]);
    expect(demoOutboundLog).toEqual([]);
  }, 300_000);
});
