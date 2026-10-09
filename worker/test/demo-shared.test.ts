// demo-shared.test.ts
//
// Plain English: demo mode's one shared rule book (shared/demo.ts), which the
// Worker's gate and the app's client guard both read. Every request is a
// "control" call (the demo switch itself), a "read" (served from the demo
// store) or "refuse" (an action: 409 while demo mode is on). Reads are by
// method; everything not named is refused, so a new write route is refused by
// default. The route census below pins today's API: 32 GETs and 54 others,
// each classified as the spec says.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_CONTROL, DEMO_READ_POSTS, DEMO_REFUSED_MESSAGE, DEMO_DATA_HEADER, DEMO_STORY, demoRouteKind } from "../../shared/demo";
import { buildApi } from "../src/api";

describe("demoRouteKind", () => {
  it.each([
    ["GET", "/overview", "read"],
    ["HEAD", "/clients", "read"],
    ["get", "/overview", "read"],
    ["POST", "/firewall/simulate", "read"],
    ["GET", "/demo", "control"],
    ["PUT", "/demo", "control"],
    ["POST", "/demo/refresh", "control"],
    ["POST", "/deploy", "refuse"],
    ["PUT", "/prefs/overview", "refuse"],
    ["DELETE", "/clients/3", "refuse"],
    ["POST", "/demo", "refuse"],
    ["DELETE", "/demo", "refuse"],
    ["GET", "/demo/refresh", "read"],
    ["PATCH", "/anything", "refuse"],
    ["OPTIONS", "/overview", "refuse"],
  ] as const)("%s %s → %s", (method, path, kind) => {
    expect(demoRouteKind(method, path)).toBe(kind);
  });

  it("ignores the query string", () => {
    expect(demoRouteKind("POST", "/firewall/simulate?x=1")).toBe("read");
    expect(demoRouteKind("PUT", "/demo?on=1")).toBe("control");
    expect(demoRouteKind("POST", "/deploy?dry=1")).toBe("refuse");
    expect(demoRouteKind("GET", "/overview?x=1")).toBe("read");
  });

  it("treats a trailing slash as a different path (no normalising, so nothing is let through by a near miss)", () => {
    expect(demoRouteKind("PUT", "/demo/")).toBe("refuse");
    expect(demoRouteKind("POST", "/firewall/simulate/")).toBe("refuse");
    expect(demoRouteKind("POST", "/demo/refresh/")).toBe("refuse");
    expect(demoRouteKind("GET", "/overview/")).toBe("read");
  });

  it("is exact about case and encoding: a disguised path is refused, never promoted", () => {
    expect(demoRouteKind("POST", "/Firewall/Simulate")).toBe("refuse");
    expect(demoRouteKind("POST", "/firewall/%73imulate")).toBe("refuse");
    expect(demoRouteKind("PUT", "/%64emo")).toBe("refuse");
  });

  it("names the control routes and the one read-only POST", () => {
    expect(DEMO_CONTROL).toEqual([
      { method: "GET", path: "/demo" },
      { method: "PUT", path: "/demo" },
      { method: "POST", path: "/demo/refresh" },
    ]);
    expect(DEMO_READ_POSTS).toEqual(["/firewall/simulate"]);
  });

  it("has the fixed words and names", () => {
    expect(DEMO_REFUSED_MESSAGE).toBe("Demo mode is on: actions are off.");
    expect(DEMO_DATA_HEADER).toBe("X-WG-Data");
    expect(DEMO_STORY).toBe("everything");
  });
});

/** Every route registered on buildApi(), as Hono lists it (middleware and the catch-all left out). */
function apiRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of buildApi().routes) {
    if (r.method === "ALL" || r.path === "*" || r.path === "/*") continue;
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

/** A concrete path for a Hono pattern (":id" → "1"), so demoRouteKind sees what a request would carry. */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "1");

describe("the route census (spec ruling 4)", () => {
  it("has 32 GET routes and 59 others (42 POST, 10 PUT, 7 DELETE; the plan's 54 counted api/labs.ts's loop of six as one), not counting demo mode's own control routes", () => {
    const routes = apiRoutes().filter((r) => r.path !== "/demo" && !r.path.startsWith("/demo/"));
    const by = (m: string) => routes.filter((r) => r.method === m).length;
    expect(by("GET")).toBe(32);
    expect(by("POST")).toBe(42);
    expect(by("PUT")).toBe(10);
    expect(by("DELETE")).toBe(7);
    expect(routes.length).toBe(91);
  });

  it("every GET is a read except GET /demo (control, once registered); every other method is refused except simulate", () => {
    for (const r of apiRoutes()) {
      const kind = demoRouteKind(r.method, concrete(r.path));
      if (r.method === "GET") expect(kind, `${r.method} ${r.path}`).toBe(r.path === "/demo" ? "control" : "read");
      else if (r.method === "POST" && r.path === "/firewall/simulate") expect(kind).toBe("read");
      else if (DEMO_CONTROL.some((c) => c.method === r.method && c.path === r.path)) expect(kind).toBe("control");
      else expect(kind, `${r.method} ${r.path}`).toBe("refuse");
    }
  });

  it("POST /firewall/simulate is documented as writing nothing", () => {
    const src = readFileSync(new URL("../src/api/simulate.ts", import.meta.url), "utf8");
    expect(src).toMatch(/nothing is written|writes nothing|Nothing is written/i);
  });
});

describe("the demo_mode switch table (migration 0022)", () => {
  it("is one row per person, keyed by the Access email, without rowid", () => {
    const sql = readFileSync(new URL("../migrations/0022_demo_mode.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS demo_mode/);
    expect(sql).toMatch(/user\s+TEXT\s+PRIMARY KEY/);
    expect(sql).toMatch(/since\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/WITHOUT ROWID/);
  });
});

describe("wrangler.toml binds the DemoStore", () => {
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  it("as DEMO_STORE, class DemoStore", () => {
    expect(toml).toMatch(/\[\[durable_objects\.bindings\]\]\s*\nname = "DEMO_STORE"\s*\nclass_name = "DemoStore"/);
  });
  it("with a v2 SQLite class migration after RunLock's v1", () => {
    expect(toml).toMatch(/\[\[migrations\]\]\s*\ntag = "v1"\s*\nnew_sqlite_classes = \["RunLock"\]/);
    expect(toml).toMatch(/\[\[migrations\]\]\s*\ntag = "v2"\s*\nnew_sqlite_classes = \["DemoStore"\]/);
    expect(toml.indexOf('tag = "v1"')).toBeLessThan(toml.indexOf('tag = "v2"'));
  });
  it("sets no CPU limit (Workers Paid default; decision 2026-10-08)", () => {
    expect(toml).not.toMatch(/cpu_ms/);
  });
});
