// demo-gate.test.ts
//
// Plain English: the demo gate (worker/src/demo/gate.ts, spec §5), the one
// decision every signed-in request passes through. Proved here, step by step:
//   - demo's own switch passes through in both modes;
//   - the switch is read from D1 on every request, and an unreadable switch is
//     503 demo_unknown, never a guess (§9.6);
//   - off: the real routes, marked X-WG-Data: real;
//   - on: reads come from the demo store (as the caller), marked demo; a demo
//     store failure is 503 demo_unavailable, never real data (§9.6); a capture
//     download is 404; every action is 409 demo_mode before any handler runs
//     and before the body is read, for every registered route (§9.3), and the
//     real stores do not change;
//   - one person's switch never changes another's answers (§9.5).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { apiEnv, api, base } from "./api-helpers";
import { demoInstance, fingerprint } from "./harness";
import worker from "../src/index";
import { buildApi } from "../src/api";
import { demoGate } from "../src/demo/gate";
import { demoOn, setDemo } from "../src/demo/switch";
import { seedScenario } from "../src/devseed";
import { DEMO_CONTROL, DEMO_REFUSED_MESSAGE, demoRouteKind } from "../../shared/demo";
import type { Env } from "../src/env";
import type { AuthedVars } from "../src/auth";

const NOW = "2026-10-08T10:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const same = { "Sec-Fetch-Site": "same-origin" };

/** Every route registered on buildApi() (middleware and the catch-all left out). */
function apiRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of buildApi().routes) {
    if (r.method === "ALL") continue;
    const k = `${r.method} ${r.path}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ method: r.method, path: r.path });
    }
  }
  return out;
}
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "1");
const isControl = (m: string, p: string) => DEMO_CONTROL.some((c) => c.method === m && c.path === p);

/** The Worker's front door, as the app calls it, for any path (not only /api/v1). */
async function front(env: Env, method: string, path: string, init: RequestInit = {}) {
  const r = await worker.fetch(new Request(`${base}${path}`, { method, ...init, headers: { ...same, ...(init.headers as Record<string, string>) } }), env, ctx);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, text, json, headers: r.headers };
}

/** D1 that fails only for the demo switch's table (everything else still works, so a fall-through would show). */
function switchUnreadable(env: Env) {
  const real = env.DB;
  env.DB = {
    prepare: (sql: string) => {
      if (/demo_mode/.test(sql)) throw new Error("D1: the demo_mode read failed");
      return real.prepare(sql);
    },
    batch: (s: D1PreparedStatement[]) => real.batch(s),
  } as unknown as D1Database;
}

/**
 * An app wired like index.ts (a signed-in user, then the gate, then /api/v1)
 * whose route handlers are spies: one per registered route. The user comes
 * from the X-Test-User header so two people can be tested side by side.
 */
function spyApp() {
  const hits: string[] = [];
  const app = new Hono<{ Bindings: Env; Variables: AuthedVars }>();
  app.use("*", async (c, next) => {
    c.set("user", c.req.header("X-Test-User") ?? "dev@localhost");
    await next();
  });
  app.use("*", demoGate);
  const sub = new Hono<{ Bindings: Env; Variables: AuthedVars }>();
  for (const r of apiRoutes()) {
    sub.on(r.method, r.path, (c) => {
      hits.push(`${r.method} ${r.path}`);
      return c.json({ spy: `${r.method} ${r.path}` });
    });
  }
  app.route("/api/v1", sub);
  app.get("/health", (c) => {
    hits.push("GET /health");
    return c.json({ spy: "health" });
  });
  app.get("/captures/:id", (c) => {
    hits.push("GET /captures/:id");
    return c.text("real capture");
  });
  return { app, hits };
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

describe("step 2: demo's own switch passes through in both modes", () => {
  it("GET /demo answers from api/demo.ts for a person in demo mode and out of it", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/demo")).json.on).toBe(false);
    await setDemo(env, "dev@localhost", true);
    const r = await api(env, "GET", "/demo");
    expect(r.status).toBe(200);
    expect(r.json.on).toBe(true);
    expect(r.headers.get("X-WG-Data")).toBe("demo");
  });

  it("PUT /demo { on: false } works for a person in demo mode (the way out)", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const r = await api(env, "PUT", "/demo", { on: false });
    expect(r.status).toBe(200);
    expect(r.headers.get("X-WG-Data")).toBe("real");
    expect(await demoOn(env, "dev@localhost")).toBe(false);
  });
});

describe("step 3 (§9.6): an unreadable switch is 503 demo_unknown, never real data", () => {
  it.each([
    ["GET", "/api/v1/clients"],
    ["HEAD", "/api/v1/clients"],
    ["GET", "/api/v1/overview"],
    ["POST", "/api/v1/notes/ack"],
    ["POST", "/api/v1/firewall/simulate"],
    ["GET", "/health"],
    ["GET", "/captures/0123456789abcdef"],
  ])("%s %s", async (method, path) => {
    const { env } = apiEnv();
    switchUnreadable(env);
    const r = await front(env, method, path);
    expect(r.status).toBe(503);
    if (method !== "HEAD") {
      if (path.startsWith("/api/v1/")) expect(r.json.error).toEqual({ code: "demo_unknown", message: "Could not check demo mode. Try again." });
      else expect(r.text).toBe("Could not check demo mode. Try again.");
    }
    // Neither source is claimed: the switch is unknown.
    expect(r.headers.get("X-WG-Data")).toBeNull();
  });

  it("the control routes answer the same 503", async () => {
    const { env } = apiEnv();
    switchUnreadable(env);
    expect((await api(env, "GET", "/demo")).json.error.code).toBe("demo_unknown");
    expect((await api(env, "POST", "/demo/refresh")).json.error.code).toBe("demo_unknown");
    expect((await api(env, "PUT", "/demo", { on: true })).json.error.code).toBe("demo_unknown");
    expect((await demoInstance(env).store.status(NOW)).refreshedAt).toBeNull();
  });
});

describe("step 4: off → the real routes, marked real", () => {
  it("answers real data with X-WG-Data: real on /api/v1, and leaves the demo store alone", async () => {
    const { env } = apiEnv();
    const serve = vi.spyOn(demoInstance(env).store, "serve");
    const r = await api(env, "GET", "/clients");
    expect(r.status).toBe(200);
    expect(r.json.clients).toEqual([]);
    expect(r.headers.get("X-WG-Data")).toBe("real");
    const miss = await api(env, "GET", "/no-such-route");
    expect(miss.status).toBe(404);
    expect(miss.headers.get("X-WG-Data")).toBe("real");
    const act = await api(env, "POST", "/notes/ack");
    expect(act.status).toBeLessThan(500);
    expect(act.headers.get("X-WG-Data")).toBe("real");
    expect((await front(env, "GET", "/health")).json.state).toBe("destroyed");
    expect(serve).not.toHaveBeenCalled();
  });
});

describe("step 5: on", () => {
  it("a read comes from the demo store, as the caller, marked demo and never cached", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const serve = vi.spyOn(demoInstance(env).store, "serve");
    const r = await api(env, "GET", "/clients?x=1");
    expect(r.status).toBe(200);
    expect(r.json.clients.length).toBeGreaterThanOrEqual(6);
    expect(r.headers.get("X-WG-Data")).toBe("demo");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    // The browser safety headers still apply.
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(serve).toHaveBeenCalledTimes(1);
    const [req, user] = serve.mock.calls[0];
    expect(new URL((req as Request).url).pathname + new URL((req as Request).url).search).toBe("/api/v1/clients?x=1");
    expect(user).toBe("dev@localhost");
    // The real database still has no clients.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM peers").first<{ n: number }>())!.n).toBe(0);
  }, 60_000);

  it("HEAD, the simulator and an unknown /api/v1 path are reads too", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const head = await front(env, "HEAD", "/api/v1/clients");
    expect(head.status).toBe(200);
    expect(head.headers.get("X-WG-Data")).toBe("demo");
    const sim = await api(env, "POST", "/firewall/simulate", { from: { kind: "any", value: null }, to: { kind: "any", value: null }, proto: "tcp", port: 443 });
    expect(sim.status).toBe(200);
    expect(sim.headers.get("X-WG-Data")).toBe("demo");
    const miss = await api(env, "GET", "/no-such-route");
    expect(miss.status).toBe(404);
    expect(miss.headers.get("X-WG-Data")).toBe("demo");
  }, 60_000);

  it("GET /health answers from the demo snapshot", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const r = await front(env, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("running");
    expect(r.headers.get("X-WG-Data")).toBe("demo");
  }, 60_000);

  it("GET /captures/<16 hex> is 404 'Not available in demo mode.', even when the real capture exists", async () => {
    const { env } = apiEnv();
    await env.STATE.put("captures/0123456789abcdef.pcap.gz", new TextEncoder().encode("real pcap").buffer as ArrayBuffer);
    await setDemo(env, "dev@localhost", true);
    const r = await front(env, "GET", "/captures/0123456789abcdef");
    expect(r.status).toBe(404);
    expect(r.text).toBe("Not available in demo mode.");
    expect((await front(env, "GET", "/captures/nothex")).text).toBe("Not available in demo mode.");
  });

  it("a demo store failure is 503 demo_unavailable, never real data", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    vi.spyOn(demoInstance(env).store, "serve").mockRejectedValue(new Error("store down"));
    const r = await api(env, "GET", "/clients");
    expect(r.status).toBe(503);
    expect(r.json.error).toEqual({ code: "demo_unavailable", message: "Demo data could not be read. Turn demo mode off or refresh it in Settings." });
    expect(r.headers.get("X-WG-Data")).toBe("demo");
    const h = await front(env, "GET", "/health");
    expect(h.status).toBe(503);
    expect(h.text).not.toContain("destroyed");
  });

  it("an action is 409 demo_mode, marked demo, before the body is even read", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    let pulled = false;
    const bodyStream = new ReadableStream({
      pull(c) {
        pulled = true;
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    }, { highWaterMark: 0 });
    const r = await worker.fetch(new Request(`${base}/api/v1/deploy`, { method: "POST", headers: { ...same, "Content-Type": "application/json" }, body: bodyStream, duplex: "half" } as RequestInit), env, ctx);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "demo_mode", message: DEMO_REFUSED_MESSAGE } });
    expect(r.headers.get("X-WG-Data")).toBe("demo");
    expect(pulled).toBe(false);
  });

  it("an old dashboard page (HX request) is still told to reload", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const r = await front(env, "POST", "/actions/deploy", { headers: { "HX-Request": "true" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("HX-Refresh")).toBe("true");
  });

  it("a cross-site action is still 403 (the same-origin check runs first)", async () => {
    const { env } = apiEnv();
    await setDemo(env, "dev@localhost", true);
    const r = await front(env, "POST", "/api/v1/deploy", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(r.status).toBe(403);
  });
});

describe("§9.3: every action, on every registered route, is refused before any handler runs", () => {
  const routes = apiRoutes();
  const actions = routes.filter((r) => r.method !== "GET" && !isControl(r.method, r.path) && !(r.method === "POST" && r.path === "/firewall/simulate"));

  it("covers the census: 58 actions (59 non-GET less the simulator; demo's own switch aside)", () => {
    expect(actions).toHaveLength(58);
    for (const a of actions) expect(demoRouteKind(a.method, concrete(a.path)), `${a.method} ${a.path}`).toBe("refuse");
  });

  it("with demo on, no route handler is ever called (except demo's own switch); with it off, each one is", async () => {
    const { env } = apiEnv();
    const { app, hits } = spyApp();
    const call = (method: string, path: string, user = "dev@localhost") =>
      app.fetch(new Request(`${base}${path}`, { method, headers: { "X-Test-User": user, "Content-Type": "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : "{}" }), env, ctx);

    // Off: every route reaches its own handler (so the spies would see a fall-through).
    for (const r of routes) {
      const res = await call(r.method, `/api/v1${concrete(r.path)}`);
      expect(res.headers.get("X-WG-Data"), `${r.method} ${r.path}`).toBe("real");
    }
    expect(hits).toHaveLength(routes.length);
    hits.length = 0;

    await setDemo(env, "dev@localhost", true);
    for (const a of actions) {
      const res = await call(a.method, `/api/v1${concrete(a.path)}`);
      expect(res.status, `${a.method} ${a.path}`).toBe(409);
      expect(((await res.json()) as any).error.code).toBe("demo_mode");
      expect(res.headers.get("X-WG-Data")).toBe("demo");
    }
    // Reads go to the demo store, not to the real handlers.
    for (const r of routes.filter((x) => x.method === "GET" && !isControl(x.method, x.path))) await call("GET", `/api/v1${concrete(r.path)}`);
    await call("POST", "/api/v1/firewall/simulate");
    await call("GET", "/health");
    await call("GET", "/captures/0123456789abcdef");
    expect(hits).toEqual([]);

    // The control routes are the one exception: they reach their handlers.
    for (const c of DEMO_CONTROL) await call(c.method, `/api/v1${c.path}`);
    expect(hits).toEqual(DEMO_CONTROL.map((c) => `${c.method} ${c.path}`));
  }, 120_000);

  it("through the Worker: every action and every disguised one is 409 demo_mode, and the real stores do not change", async () => {
    const { env, world } = apiEnv();
    await seedScenario(env, "running", new Date(NOW));
    await setDemo(env, "dev@localhost", true);
    world.calls.length = 0;
    const before = await fingerprint(env);
    const disguised = [
      ["POST", "/api/v1/firewall/simulate/"],
      ["POST", "/api/v1/Firewall/Simulate"],
      ["POST", "/api/v1/firewall/%73imulate"],
      ["PUT", "/api/v1/demo/"],
      ["POST", "/api/v1/demo"],
      ["DELETE", "/api/v1/demo"],
      ["PATCH", "/api/v1/settings"],
      ["OPTIONS", "/api/v1/overview"],
      ["POST", "/api/v1/no-such-route"],
      ["POST", "/health"],
      ["DELETE", "/captures/0123456789abcdef"],
      ["POST", "/partials/overview"],
      ["POST", "/actions/deploy"],
      ["POST", "/alerts/ack"],
    ];
    const all = [...actions.map((a) => [a.method, `/api/v1${concrete(a.path)}`]), ...disguised];
    for (const [method, path] of all) {
      const r = await front(env, method, path, { body: "{}", headers: { "Content-Type": "application/json" } });
      expect(r.status, `${method} ${path}: ${r.text.slice(0, 120)}`).toBe(409);
      if (path.startsWith("/api/v1")) expect(r.json, `${method} ${path}`).toEqual({ error: { code: "demo_mode", message: DEMO_REFUSED_MESSAGE } });
      else expect(r.text).toBe(DEMO_REFUSED_MESSAGE);
      expect(r.headers.get("X-WG-Data")).toBe("demo");
    }
    expect(await fingerprint(env)).toEqual(before);
    expect(world.calls).toEqual([]);
    expect(world.dispatches).toEqual([]);
    expect(world.notes).toEqual([]);
  }, 120_000);
});

describe("§9.5: one person's switch never changes another's answers", () => {
  it("someone@example.com in demo does not change dev@localhost's answers", async () => {
    const { env } = apiEnv();
    await setDemo(env, "someone@example.com", true);
    const r = await api(env, "GET", "/clients");
    expect(r.json.clients).toEqual([]);
    expect(r.headers.get("X-WG-Data")).toBe("real");
    expect((await api(env, "GET", "/demo")).json.on).toBe(false);
  });

  it("side by side through the gate: the person in demo mode sees demo, the other sees real", async () => {
    const { env } = apiEnv();
    await setDemo(env, "someone@example.com", true);
    const app = new Hono<{ Bindings: Env; Variables: AuthedVars }>();
    app.use("*", async (c, next) => {
      c.set("user", c.req.header("X-Test-User")!);
      await next();
    });
    app.use("*", demoGate);
    app.route("/api/v1", buildApi());
    const get = async (user: string) => {
      const r = await app.fetch(new Request(`${base}/api/v1/clients`, { headers: { "X-Test-User": user } }), env, ctx);
      return { source: r.headers.get("X-WG-Data"), n: ((await r.json()) as any).clients.length };
    };
    const someone = await get("someone@example.com");
    expect(someone.source).toBe("demo");
    expect(someone.n).toBeGreaterThanOrEqual(6);
    expect(await get("dev@localhost")).toEqual({ source: "real", n: 0 });
  }, 60_000);

  it("PUT /demo writes only the caller's row", async () => {
    const { env } = apiEnv();
    await setDemo(env, "someone@example.com", true);
    await api(env, "PUT", "/demo", { on: true });
    await api(env, "PUT", "/demo", { on: false });
    const rows = (await env.DB.prepare("SELECT user FROM demo_mode ORDER BY user").all<{ user: string }>()).results.map((r) => r.user);
    expect(rows).toEqual(["someone@example.com"]);
  }, 60_000);
});
