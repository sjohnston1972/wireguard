// demo-control.test.ts
//
// Plain English: demo mode's own switch (spec §7): GET /api/v1/demo says
// whether the caller is in demo mode and what the demo store holds; PUT
// /api/v1/demo { on } turns it on (getting the demo store ready first) or off;
// POST /api/v1/demo/refresh re-seeds the demo store. The switch is one row per
// person in the real demo_mode table, the only real write demo mode makes.
// Every answer says which data the caller now sees (X-WG-Data).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiEnv, api, base } from "./api-helpers";
import { demoInstance } from "./harness";
import { DEMO_DAILY_ROWS, DEMO_MIN_INTERVAL_MS } from "../src/demo/store";
import { demoOn, setDemo } from "../src/demo/switch";
import { SCENARIOS } from "../src/devseed";
import type { Env } from "../src/env";
import type { DemoStatusResponse, DemoActionResponse } from "../../shared/api";

const NOW = "2026-10-08T10:00:00.000Z";
const at = (iso: string, plusMs: number) => new Date(Date.parse(iso) + plusMs).toISOString();

const rows = async (env: Env) => (await env.DB.prepare("SELECT user, since FROM demo_mode ORDER BY user").all<{ user: string; since: string }>()).results;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the switch (demo/switch.ts)", () => {
  it("is off without a row, on with one, per lower-case email", async () => {
    const { env } = apiEnv();
    expect(await demoOn(env, "dev@localhost")).toBe(false);
    await setDemo(env, "Dev@Localhost", true);
    expect(await demoOn(env, "dev@localhost")).toBe(true);
    expect(await demoOn(env, "DEV@LOCALHOST")).toBe(true);
    expect(await demoOn(env, "someone@example.com")).toBe(false);
    expect(await rows(env)).toEqual([{ user: "dev@localhost", since: NOW }]);
    await setDemo(env, "dev@localhost", false);
    expect(await demoOn(env, "dev@localhost")).toBe(false);
    expect(await rows(env)).toEqual([]);
  });

  it("throws when D1 cannot be read (the gate turns that into 503, never a guess)", async () => {
    const { env } = apiEnv();
    env.DB = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 down"); } }) }) } as unknown as D1Database;
    await expect(demoOn(env, "dev@localhost")).rejects.toThrow("D1 down");
  });
});

describe("GET /api/v1/demo", () => {
  it("is off by default with refreshedAt null, and does not seed", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/demo");
    expect(r.status).toBe(200);
    const body = r.json as DemoStatusResponse;
    expect(body).toMatchObject({ on: false, refreshedAt: null, story: "everything", rowsToday: 0, dailyRows: DEMO_DAILY_ROWS, nextRefreshAt: null });
    expect(r.headers.get("X-WG-Data")).toBe("real");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect((await demoInstance(env).store.status(NOW)).refreshedAt).toBeNull();
  });

  it("says on, and X-WG-Data demo, for a person in demo mode", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const r = await api(env, "GET", "/demo");
    expect(r.json.on).toBe(true);
    expect(r.headers.get("X-WG-Data")).toBe("demo");
  });

  it("answers 503 demo_unknown when the switch cannot be read", async () => {
    const { env } = apiEnv();
    env.DB = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    const r = await api(env, "GET", "/demo");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("demo_unknown");
  });

  it("answers 503 demo_unavailable when the demo store fails", async () => {
    const { env } = apiEnv();
    vi.spyOn(demoInstance(env).store, "status").mockRejectedValue(new Error("store down"));
    const r = await api(env, "GET", "/demo");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("demo_unavailable");
    expect(r.headers.get("X-WG-Data")).toBe("real");
  });
});

describe("PUT /api/v1/demo", () => {
  it("{ on: true } seeds an empty store before writing the row", async () => {
    const { env } = apiEnv();
    const { store } = demoInstance(env);
    const order: string[] = [];
    const ensure = store.ensureReady.bind(store);
    vi.spyOn(store, "ensureReady").mockImplementation(async (nowIso?: string) => {
      order.push(`ensureReady rows=${(await rows(env)).length}`);
      return ensure(nowIso);
    });
    const r = await api(env, "PUT", "/demo", { on: true });
    expect(r.status).toBe(200);
    const body = r.json as DemoActionResponse;
    expect(body.on).toBe(true);
    expect(body.refreshedAt).toBe(NOW);
    expect(body.message).toBe("Demo mode is on.");
    expect(order).toEqual(["ensureReady rows=0"]);
    expect(await rows(env)).toEqual([{ user: "dev@localhost", since: NOW }]);
    expect(r.headers.get("X-WG-Data")).toBe("demo");
  }, 60_000);

  it("leaves the switch off when ensureReady throws (503 demo_unavailable)", async () => {
    const { env } = apiEnv();
    vi.spyOn(demoInstance(env).store, "ensureReady").mockRejectedValue(new Error("seed blew up"));
    const r = await api(env, "PUT", "/demo", { on: true });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("demo_unavailable");
    expect(await rows(env)).toEqual([]);
    expect(r.headers.get("X-WG-Data")).toBe("real");
  });

  it("{ on: true } with an empty store over budget is 409 demo_busy naming the time, and the switch stays off", async () => {
    const { env } = apiEnv();
    const { store, state } = demoInstance(env);
    await store.status(NOW);
    state.sql.exec("INSERT OR REPLACE INTO _demo_meta (k, v) VALUES ('day', ?1), ('rowsToday', ?2), ('lastRows', ?3), ('attemptAt', ?4)", NOW.slice(0, 10), String(DEMO_DAILY_ROWS), "5000", at(NOW, -60_000));
    const r = await api(env, "PUT", "/demo", { on: true });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("demo_busy");
    expect(r.json.error.message).toMatch(/Try again at \d\d:\d\d/);
    expect(await rows(env)).toEqual([]);
    expect(r.headers.get("X-WG-Data")).toBe("real");
  });

  it("{ on: false } deletes only the caller's row, and works while the demo store is down", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    await setDemo(env, "someone@example.com", true);
    vi.spyOn(demoInstance(env).store, "status").mockRejectedValue(new Error("store down"));
    const r = await api(env, "PUT", "/demo", { on: false });
    expect(r.status).toBe(200);
    expect(r.json.on).toBe(false);
    expect(r.json.message).toBe("Demo mode is off. Showing your real data.");
    expect(r.headers.get("X-WG-Data")).toBe("real");
    expect((await rows(env)).map((x) => x.user)).toEqual(["someone@example.com"]);
  });

  it.each([[{}], [{ on: "yes" }], [{ on: 1 }], [[true]], [null]])("a bad body %j is 400 bad_input and changes nothing", async (b) => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/demo", b);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("bad_input");
    expect(await rows(env)).toEqual([]);
    expect(r.headers.get("X-WG-Data")).toBe("real");
  });

  it("a body that is not JSON is 400 bad_input", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/demo", undefined, { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("bad_input");
  });

  it("a cross-site PUT is 403 and changes nothing", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/demo", { on: true }, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(await rows(env)).toEqual([]);
    expect((await demoInstance(env).store.status(NOW)).refreshedAt).toBeNull();
  });
});

describe("POST /api/v1/demo/refresh", () => {
  it("works with demo mode off and on; a second within 10 minutes is 409 demo_busy naming the time", async () => {
    const { env } = apiEnv();
    const off = await api(env, "POST", "/demo/refresh");
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ on: false, refreshedAt: NOW, message: "Demo data refreshed." });
    expect(off.json.rowsToday).toBeGreaterThan(1000);
    expect(off.json.nextRefreshAt).toBe(at(NOW, DEMO_MIN_INTERVAL_MS));
    expect(off.headers.get("X-WG-Data")).toBe("real");
    expect(await rows(env)).toEqual([]);

    await setDemo(env, "dev@localhost", true);
    vi.setSystemTime(new Date(at(NOW, 60_000)));
    const busy = await api(env, "POST", "/demo/refresh");
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("demo_busy");
    // 10:10 UTC is 11:10 in London.
    expect(busy.json.error.message).toBe("Demo data was refreshed less than 10 minutes ago. Try again at 11:10.");
    expect(busy.headers.get("X-WG-Data")).toBe("demo");

    const later = at(NOW, DEMO_MIN_INTERVAL_MS);
    vi.setSystemTime(new Date(later));
    const on = await api(env, "POST", "/demo/refresh");
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ on: true, refreshedAt: later });
    expect(on.headers.get("X-WG-Data")).toBe("demo");
  }, 120_000);

  it("a DemoStore failure is 503 demo_unavailable", async () => {
    const { env } = apiEnv();
    vi.spyOn(demoInstance(env).store, "refresh").mockRejectedValue(new Error("boom"));
    const r = await api(env, "POST", "/demo/refresh");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("demo_unavailable");
  });
});

describe("the dev seed list in GET /demo (spec ruling 20, §9.11)", () => {
  it("lists the scenarios only with the bypass on localhost", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/demo");
    expect(r.json.devSeed).toEqual({ scenarios: [...SCENARIOS] });
  });

  it("is null without the bypass", async () => {
    // Without the bypass the login needs Access: drive the API directly with a signed-in user.
    const { env } = apiEnv({ AUTH_DEV_BYPASS: undefined });
    const { buildApi } = await import("../src/api");
    const { Hono } = await import("hono");
    const app = new Hono<{ Bindings: Env; Variables: { user: string } }>();
    app.use("*", async (c, next) => {
      c.set("user", "someone@example.com");
      await next();
    });
    app.route("/api/v1", buildApi());
    const r = await app.fetch(new Request(`${base}/api/v1/demo`), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(((await r.json()) as DemoStatusResponse).devSeed).toBeNull();
  });

  it("is null off localhost even with the bypass", async () => {
    const { env } = apiEnv();
    const { buildApi } = await import("../src/api");
    const { Hono } = await import("hono");
    const app = new Hono<{ Bindings: Env; Variables: { user: string } }>();
    app.use("*", async (c, next) => {
      c.set("user", "dev@localhost");
      await next();
    });
    app.route("/api/v1", buildApi());
    const r = await app.fetch(new Request("https://wg-admin.example/api/v1/demo"), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(((await r.json()) as DemoStatusResponse).devSeed).toBeNull();
  });
});
