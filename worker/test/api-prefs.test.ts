// api-prefs.test.ts
//
// Plain English: widget preferences through the JSON API, as the app uses
// them: GET /api/v1/prefs and PUT /api/v1/prefs/:page. Every save is checked
// against shared/widgets.ts; a refusal names the field; a save made on an
// old version is a 409 that changes nothing; the owner is always the
// signed-in identity, never something the request says.
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../src/index";
import { api, apiEnv, base } from "./api-helpers";
import { EXPORT_TABLES } from "../src/backup";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

async function count(env: Env, table: string) {
  return Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n);
}

/** A PUT with a raw body, for bodies JSON.stringify would not make. */
async function putRaw(env: Env, page: string, text: string, headers: Record<string, string> = {}) {
  const r = await worker.fetch(new Request(`${base}/api/v1/prefs/${page}`, { method: "PUT", body: text, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers } }), env, ctx);
  return { status: r.status, json: await r.json<any>() };
}

describe("GET /prefs", () => {
  it("GET prefs for a new user is five pages at version 0", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/prefs");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.json).toEqual({
      pages: Object.fromEntries(["overview", "clients", "firewall", "activity", "cost"].map((p) => [p, { version: 0, updatedAt: null, prefs: {} }])),
    });
  });
});

describe("PUT /prefs/:page", () => {
  it("PUT then GET round-trips, normalised and sparse (defaults stripped)", async () => {
    const { env } = apiEnv();
    const prefs = {
      layout: { order: { r3: ["side", "overview.run", "overview.traffic", "overview.vmPerformance"], r2: ["overview.topology", "overview.keyMetrics"] }, hidden: ["overview.speedTest"] },
      widgets: {
        "overview.keyMetrics": { v: 1, s: { range: "live", tiles: ["latency", "endpoint"], availability: { warn: 99.5, bad: 90 } } },
        "overview.events": { v: 1, s: { rows: 5, detail: true } },
      },
    };
    const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs });
    expect(r.status, r.text).toBe(200);
    const want = {
      layout: { order: { r3: ["side", "overview.run", "overview.traffic", "overview.vmPerformance"] }, hidden: ["overview.speedTest"] },
      widgets: { "overview.keyMetrics": { v: 1, s: { tiles: ["endpoint", "latency"], availability: { warn: 99.5, bad: 90 } } } },
    };
    expect(r.json).toEqual({ version: 1, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), prefs: want });
    const g = await api(env, "GET", "/prefs");
    expect(g.json.pages.overview).toEqual(r.json);
    expect(g.json.pages.cost).toEqual({ version: 0, updatedAt: null, prefs: {} });
  });

  it("PUT refuses an unknown widget, unknown key, wrong enum, off-step or out-of-range number, unknown or duplicate column, with the field path", async () => {
    const { env } = apiEnv();
    const cases: [string, unknown, string][] = [
      ["overview", { widgets: { "overview.nope": { v: 1, s: {} } } }, "widgets.overview.nope"],
      ["overview", { widgets: { "overview.events": { v: 1, s: { colour: "red" } } } }, "widgets.overview.events.colour"],
      ["overview", { widgets: { "overview.keyMetrics": { v: 1, s: { range: "2h" } } } }, "widgets.overview.keyMetrics.range"],
      ["firewall", { widgets: { "firewall.capture": { v: 1, s: { seconds: 31 } } } }, "widgets.firewall.capture.seconds"],
      ["overview", { widgets: { "overview.events": { v: 1, s: { rows: 1e9 } } } }, "widgets.overview.events.rows"],
      ["clients", { widgets: { "clients.table": { v: 1, s: { columns: ["address", "password"] } } } }, "widgets.clients.table.columns"],
      ["clients", { widgets: { "clients.table": { v: 1, s: { columns: ["address", "address"] } } } }, "widgets.clients.table.columns"],
      ["cost", { theme: "dark" }, "theme"],
    ];
    for (const [page, prefs, field] of cases) {
      const r = await api(env, "PUT", `/prefs/${page}`, { schema: 2, baseVersion: 0, prefs });
      expect(r.status, field).toBe(400);
      expect(r.json.error, field).toMatchObject({ code: "bad_input", field });
    }
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("refuses a body that is not { baseVersion, prefs }", async () => {
    const { env } = apiEnv();
    const bad: [unknown, string][] = [
      [{ prefs: {} }, "baseVersion"],
      [{ schema: 2, baseVersion: "0", prefs: {} }, "baseVersion"],
      [{ schema: 2, baseVersion: -1, prefs: {} }, "baseVersion"],
      [{ schema: 2, baseVersion: 0.5, prefs: {} }, "baseVersion"],
      [{ schema: 2, baseVersion: 0 }, "prefs"],
      [{ schema: 2, baseVersion: 0, prefs: [] }, "prefs"],
      [{ schema: 2, baseVersion: 0, prefs: {}, user: "someone@example.net" }, "user"],
    ];
    for (const [b, field] of bad) {
      const r = await api(env, "PUT", "/prefs/overview", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.field, JSON.stringify(b)).toBe(field);
    }
    expect((await putRaw(env, "overview", "{ nope")).status).toBe(400);
    expect((await putRaw(env, "overview", "")).status).toBe(400);
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("PUT over 16 KiB is 400 before parsing", async () => {
    const { env } = apiEnv();
    // Not even JSON: refused for its size, before anyone tries to read it.
    const r = await putRaw(env, "overview", "x".repeat(16 * 1024 + 1));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: "bad_input", field: "prefs", message: expect.stringMatching(/16 KiB/) });
    // A Content-Length that says so is enough.
    const big = JSON.stringify({ schema: 2, baseVersion: 0, prefs: {}, pad: "y".repeat(17_000) });
    expect((await putRaw(env, "overview", big)).json.error.message).toMatch(/16 KiB/);
    // Exactly at the cap is read (and refused for what it says, not its size).
    const at = JSON.stringify({ schema: 2, baseVersion: 0, prefs: {}, pad: "" });
    const padded = at.replace('"pad":""', `"pad":"${"z".repeat(16 * 1024 - at.length)}"`);
    expect(padded.length).toBe(16 * 1024);
    expect((await putRaw(env, "overview", padded)).json.error.field).toBe("pad");
  });

  it("hidden may not include a pinned widget", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["overview.status"] } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ field: "layout.hidden", message: "Status banner can't be hidden." });
  });

  it("order must be a permutation of its row", async () => {
    const { env } = apiEnv();
    for (const order of [["overview.run", "overview.traffic"], ["overview.run", "overview.traffic", "side", "side"], ["overview.run", "overview.traffic", "overview.notes"]]) {
      const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: { layout: { order: { r3: order } } } });
      expect(r.status, order.join()).toBe(400);
      expect(r.json.error.field).toBe("layout.order.r3");
    }
  });

  it("unknown page is 404", async () => {
    const { env } = apiEnv();
    for (const page of ["settings", "nope", "__proto__", "Overview"]) {
      const r = await api(env, "PUT", `/prefs/${page}`, { schema: 2, baseVersion: 0, prefs: {} });
      expect(r.status, page).toBe(404);
      expect(r.json.error).toEqual({ code: "not_found", message: "No such page." });
    }
  });

  it("a stale baseVersion is 409 stale and changes nothing", async () => {
    const { env } = apiEnv();
    expect((await api(env, "PUT", "/prefs/cost", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["cost.insights"] } } })).status).toBe(200);
    const before = await api(env, "GET", "/prefs");
    // Another device saved version 1 first; this tab still thinks the page was never saved.
    const r = await api(env, "PUT", "/prefs/cost", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["cost.forecast"] } } });
    expect(r.status).toBe(409);
    expect(r.json.error).toEqual({ code: "stale", message: "Changed on another device. Showing the latest." });
    expect((await api(env, "PUT", "/prefs/cost", { schema: 2, baseVersion: 5, prefs: {} })).status).toBe(409);
    expect(await api(env, "GET", "/prefs")).toMatchObject({ json: before.json });
  });

  it("PUT with an old schema version is 409 outdated", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: { widgets: { "overview.events": { v: 0, s: { rows: 7 } } } } });
    expect(r.status).toBe(409);
    expect(r.json.error).toEqual({ code: "outdated", message: "This tab is running an older dashboard. Reload to change widget settings.", field: "widgets.overview.events.v" });
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("PUT without schema 2 is 409 outdated and changes nothing", async () => {
    const { env } = apiEnv();
    expect((await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["overview.notes"] } } })).status).toBe(200);
    const before = await api(env, "GET", "/prefs");
    // An older bundle sends no schema: it would drop `shown` on every save, so it is told to reload.
    for (const b of [{ baseVersion: 1, prefs: {} }, { schema: 1, baseVersion: 1, prefs: {} }]) {
      const r = await api(env, "PUT", "/prefs/overview", b);
      expect(r.status, JSON.stringify(b)).toBe(409);
      expect(r.json.error, JSON.stringify(b)).toEqual({ code: "outdated", message: "This tab is running an older dashboard. Reload to change widget settings.", field: "schema" });
    }
    // A schema this Worker does not know is bad input, not a reload.
    for (const schema of [3, "2", null]) {
      const r = await api(env, "PUT", "/prefs/overview", { schema, baseVersion: 1, prefs: {} });
      expect(r.status, String(schema)).toBe(400);
      expect(r.json.error, String(schema)).toMatchObject({ code: "bad_input", field: "schema" });
    }
    expect(await api(env, "GET", "/prefs")).toMatchObject({ json: before.json });
  });

  it("PUT with shown round-trips sparse", async () => {
    const { env } = apiEnv();
    const prefs = { layout: { hidden: ["overview.traffic"], shown: ["overview.vmPerformance"], order: { r3: ["overview.run", "overview.vmPerformance", "side", "overview.traffic"] } }, widgets: { "overview.vmPerformance": { v: 1, s: { range: "24h", peaks: true } } } };
    const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs });
    expect(r.status, r.text).toBe(200);
    const want = { layout: { order: { r3: ["overview.run", "overview.vmPerformance", "side", "overview.traffic"] }, hidden: ["overview.traffic"], shown: ["overview.vmPerformance"] }, widgets: { "overview.vmPerformance": { v: 1, s: { peaks: true } } } };
    expect(r.json.prefs).toEqual(want);
    expect((await api(env, "GET", "/prefs")).json.pages.overview.prefs).toEqual(want);
    // Turning it off again stores nothing for it.
    const off = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 1, prefs: { layout: { hidden: ["overview.traffic"], shown: [] } } });
    expect(off.json.prefs).toEqual({ layout: { hidden: ["overview.traffic"] } });
  });

  it("PUT that overfills a row is 400 naming layout.shown", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/prefs/activity", { schema: 2, baseVersion: 0, prefs: { layout: { shown: ["activity.serviceHealth"] } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ code: "bad_input", field: "layout.shown", message: "Activity row 3 is full. Turn a widget off first." });
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("reset writes {} and the version still rises", async () => {
    const { env } = apiEnv();
    await api(env, "PUT", "/prefs/activity", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["activity.timeline"] } } });
    const r = await api(env, "PUT", "/prefs/activity", { schema: 2, baseVersion: 1, prefs: {} });
    expect(r.json).toEqual({ version: 2, updatedAt: expect.any(String), prefs: {} });
    expect((await api(env, "GET", "/prefs")).json.pages.activity).toEqual({ version: 2, updatedAt: expect.any(String), prefs: {} });
  });

  it("saving prefs writes only ui_prefs", async () => {
    const { env } = apiEnv();
    const tables = ["settings", "alerts", "audit"];
    const before = await Promise.all(tables.map((t) => count(env, t)));
    await api(env, "PUT", "/prefs/cost", { schema: 2, baseVersion: 0, prefs: { widgets: { "cost.kpis": { v: 1, s: { budgetUsed: { warn: 50, bad: 90 } } } } } });
    await api(env, "PUT", "/prefs/cost", { schema: 2, baseVersion: 1, prefs: {} });
    expect(await Promise.all(tables.map((t) => count(env, t)))).toEqual(before);
    expect(await count(env, "ui_prefs")).toBe(1);
    // Cosmetic and per user: never in the backup export.
    expect(Object.values(EXPORT_TABLES)).not.toContain("ui_prefs");
  });

  it("PUT without same-origin is refused", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: {} }, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
    expect((await api(env, "PUT", "/prefs/overview", { schema: 2, baseVersion: 0, prefs: {} }, {})).status).toBe(403);
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("the owner is the signed-in identity (dev@localhost under the bypass), whatever the request says", async () => {
    const { env } = apiEnv();
    await api(env, "PUT", "/prefs/overview?user=someone@example.net", { schema: 2, baseVersion: 0, prefs: { layout: { hidden: ["overview.notes"] } } });
    const rows = (await env.DB.prepare("SELECT user, page FROM ui_prefs").all<{ user: string; page: string }>()).results;
    expect(rows).toEqual([{ user: "dev@localhost", page: "overview" }]);
  });
});
