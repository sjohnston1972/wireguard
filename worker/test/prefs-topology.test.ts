// prefs-topology.test.ts
//
// Plain English: a lab diagram's saved arrangement (lab topology spec §8.2-§8.3,
// ruling 17), one ui_prefs row per person per lab with page "topology:<lab id>":
// migration 0021 (the table rebuilt with a wider page check, every row kept),
// GET and PUT /api/v1/prefs/topology/:labId (optimistic version, strict
// validation naming the field, size caps before parsing, 404 outside the
// catalogue), per user, and never in the backup export.

import { describe, it, expect, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import worker from "../src/index";
import { api, apiEnv, base } from "./api-helpers";
import { makeEnv } from "./harness";
import { buildExport, EXPORT_TABLES } from "../src/backup";
import { getPrefs, getTopologyLayout, putTopologyLayout } from "../src/prefs";
import { EMPTY_LAYOUT, MAX_TOPOLOGY_BODY_BYTES, MAX_TOPOLOGY_ENTRIES, normaliseTopologyLayout, topologyPage, validateTopologyLayout, type TopologyLayout } from "../../shared/topology/layout";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const LAB = "az104-13-vnets";
const layout = (nodes: TopologyLayout["nodes"]): TopologyLayout => ({ v: 1, nodes });
const one = layout({ "microsoft.compute/virtualmachines/vm-web": { x: 40, y: 120, p: "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-web" } });

async function count(env: Env, table: string) {
  return Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n);
}

async function putRaw(env: Env, labId: string, text: string, headers: Record<string, string> = {}) {
  const r = await worker.fetch(new Request(`${base}/api/v1/prefs/topology/${labId}`, { method: "PUT", body: text, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers } }), env, ctx);
  return { status: r.status, json: await r.json<any>() };
}

describe("migration 0021", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();

  it("0021 keeps every ui_prefs row and refuses a page that is neither a widget page nor topology:<id>", () => {
    expect(files).toContain("0021_ui_prefs_topology.sql");
    const db = new DatabaseSync(":memory:");
    // A copy of the real schema as it stands before 0021.
    for (const f of files.filter((f) => f < "0021")) db.exec(readFileSync(new URL(f, dir), "utf8"));
    const ins = db.prepare("INSERT INTO ui_prefs (user, page, json, version, updated_at) VALUES (?, ?, ?, ?, ?)");
    const rows = [
      ["a@example.com", "overview", '{"layout":{"hidden":["overview.notes"]}}', 4, "2026-10-01T00:00:00.000Z"],
      ["a@example.com", "cost", "{}", 2, "2026-10-02T00:00:00.000Z"],
      ["b@example.com", "clients", '{"widgets":{}}', 7, "2026-10-03T00:00:00.000Z"],
      ["b@example.com", "firewall", "{}", 1, "2026-10-04T00:00:00.000Z"],
      ["b@example.com", "activity", "{}", 3, "2026-10-05T00:00:00.000Z"],
    ];
    for (const r of rows) ins.run(...(r as [string, string, string, number, string]));
    // Before 0021 a topology page is refused.
    expect(() => ins.run("a@example.com", `topology:${LAB}`, "{}", 1, "x")).toThrow(/CHECK/);
    const before = db.prepare("SELECT * FROM ui_prefs ORDER BY user, page").all();

    db.exec(readFileSync(new URL("0021_ui_prefs_topology.sql", dir), "utf8"));
    expect(db.prepare("SELECT * FROM ui_prefs ORDER BY user, page").all()).toEqual(before);
    // Same columns and key, still WITHOUT ROWID.
    const cols = db.prepare("PRAGMA table_info(ui_prefs)").all() as { name: string; pk: number }[];
    expect(cols.map((c) => [c.name, c.pk])).toEqual([["user", 1], ["page", 2], ["json", 0], ["version", 0], ["updated_at", 0]]);
    expect(String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ui_prefs'").get() as { sql: string }).sql)).toMatch(/WITHOUT ROWID/i);

    ins.run("a@example.com", `topology:${LAB}`, "{}", 1, "x");
    ins.run("a@example.com", "topology:az700-43-private-link", "{}", 1, "x");
    for (const bad of ["bogus", "settings", "topology:../x", "topology:", "topology:az104-13", `topology:${"az104-13-" + "x".repeat(60)}`]) {
      expect(() => ins.run("a@example.com", bad, "{}", 1, "x"), bad).toThrow(/CHECK/);
    }
  });
});

describe("layout validation (shared/topology/layout.ts)", () => {
  it("topologyPage names the row", () => {
    expect(topologyPage(LAB)).toBe(`topology:${LAB}`);
    expect(EMPTY_LAYOUT).toEqual({ v: 1, nodes: {} });
  });

  it("validation refuses unknown keys, v not 1, over 300 entries, a non-integer or out-of-range coordinate, a key with a quote, with the field", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_TOPOLOGY_ENTRIES + 1 }, (_, i) => [`k${i}`, { x: 0, y: 0, p: null }]));
    const cases: [unknown, string][] = [
      [null, "layout"],
      [[], "layout"],
      [{ v: 1, nodes: {}, extra: 1 }, "layout.extra"],
      [{ v: 2, nodes: {} }, "layout.v"],
      [{ nodes: {} }, "layout.v"],
      [{ v: 1 }, "layout.nodes"],
      [{ v: 1, nodes: [] }, "layout.nodes"],
      [{ v: 1, nodes: many }, "layout.nodes"],
      [{ v: 1, nodes: { a: { x: 1.5, y: 0, p: null } } }, "layout.nodes.a.x"],
      [{ v: 1, nodes: { a: { x: 0, y: 100_001, p: null } } }, "layout.nodes.a.y"],
      [{ v: 1, nodes: { a: { x: -100_001, y: 0, p: null } } }, "layout.nodes.a.x"],
      [{ v: 1, nodes: { a: { x: "1", y: 0, p: null } } }, "layout.nodes.a.x"],
      [{ v: 1, nodes: { a: { x: 0, y: 0 } } }, "layout.nodes.a.p"],
      [{ v: 1, nodes: { a: { x: 0, y: 0, p: 5 } } }, "layout.nodes.a.p"],
      [{ v: 1, nodes: { a: { x: 0, y: 0, p: 'a"b' } } }, "layout.nodes.a.p"],
      [{ v: 1, nodes: { a: { x: 0, y: 0, p: null, z: 1 } } }, "layout.nodes.a.z"],
      [{ v: 1, nodes: { 'vm"x': { x: 0, y: 0, p: null } } }, "layout.nodes"],
      [{ v: 1, nodes: { "vm'x": { x: 0, y: 0, p: null } } }, "layout.nodes"],
      [{ v: 1, nodes: { "vm\nx": { x: 0, y: 0, p: null } } }, "layout.nodes"],
      [{ v: 1, nodes: { ["k".repeat(201)]: { x: 0, y: 0, p: null } } }, "layout.nodes"],
      [{ v: 1, nodes: { "": { x: 0, y: 0, p: null } } }, "layout.nodes"],
    ];
    for (const [raw, field] of cases) {
      const p = validateTopologyLayout(raw);
      expect(p, JSON.stringify(raw).slice(0, 80)).not.toBeNull();
      expect(p!.field, JSON.stringify(raw).slice(0, 80)).toBe(field);
      expect(p!.message.length).toBeGreaterThan(0);
    }
    expect(validateTopologyLayout(one)).toBeNull();
    expect(validateTopologyLayout({ v: 1, nodes: { a: { x: 100_000, y: -100_000, p: "lane/global" } } })).toBeNull();
    expect(validateTopologyLayout(EMPTY_LAYOUT)).toBeNull();
  });

  it("normaliseTopologyLayout sorts keys and drops what does not validate", () => {
    expect(JSON.stringify(normaliseTopologyLayout({ v: 1, nodes: { b: { x: 1, y: 2, p: null }, a: { p: "q", y: 4, x: 3 } } }))).toBe('{"v":1,"nodes":{"a":{"x":3,"y":4,"p":"q"},"b":{"x":1,"y":2,"p":null}}}');
    expect(normaliseTopologyLayout("junk")).toEqual(EMPTY_LAYOUT);
    expect(normaliseTopologyLayout({ v: 1, nodes: { a: { x: 1.5, y: 0, p: null }, b: { x: 1, y: 1, p: null } } })).toEqual({ v: 1, nodes: { b: { x: 1, y: 1, p: null } } });
  });
});

describe("GET and PUT /prefs/topology/:labId", () => {
  it("GET answers version 0 and an empty layout when never saved", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", `/prefs/topology/${LAB}`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ version: 0, updatedAt: null, layout: { v: 1, nodes: {} } });
  });

  it("PUT stores, bumps the version and answers the page", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 0, layout: one });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ version: 1, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), layout: one });
    expect((await api(env, "GET", `/prefs/topology/${LAB}`)).json).toEqual(r.json);
    const r2 = await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 1, layout: EMPTY_LAYOUT });
    expect(r2.json).toEqual({ version: 2, updatedAt: expect.any(String), layout: EMPTY_LAYOUT });
    const row = await env.DB.prepare("SELECT user, page, version FROM ui_prefs").first<{ user: string; page: string; version: number }>();
    expect(row).toEqual({ user: "dev@localhost", page: `topology:${LAB}`, version: 2 });
  });

  it("a stale baseVersion is 409 and changes nothing", async () => {
    const { env } = apiEnv();
    await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 0, layout: one });
    for (const baseVersion of [0, 2]) {
      const r = await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion, layout: EMPTY_LAYOUT });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("stale");
    }
    expect((await api(env, "GET", `/prefs/topology/${LAB}`)).json).toMatchObject({ version: 1, layout: one });
  });

  it("an id outside the catalogue is 404", async () => {
    const { env } = apiEnv();
    for (const id of ["az104-99-nope", "bogus", "az104-13-vnets-x"]) {
      expect((await api(env, "GET", `/prefs/topology/${id}`)).status, id).toBe(404);
      const p = await api(env, "PUT", `/prefs/topology/${id}`, { baseVersion: 0, layout: one });
      expect(p.status, id).toBe(404);
      expect(p.json.error.code).toBe("not_found");
    }
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("the API refuses a bad layout or body with the field, writing nothing", async () => {
    const { env } = apiEnv();
    const cases: [unknown, string][] = [
      [{ baseVersion: 0, layout: { v: 2, nodes: {} } }, "layout.v"],
      [{ baseVersion: 0, layout: { v: 1, nodes: { 'a"': { x: 0, y: 0, p: null } } } }, "layout.nodes"],
      [{ baseVersion: 0, layout: { v: 1, nodes: { a: { x: 0.5, y: 0, p: null } } } }, "layout.nodes.a.x"],
      [{ baseVersion: 0 }, "layout"],
      [{ baseVersion: -1, layout: one }, "baseVersion"],
      [{ baseVersion: "0", layout: one }, "baseVersion"],
      [{ baseVersion: 0, layout: one, user: "x@example.com" }, "user"],
    ];
    for (const [b, field] of cases) {
      const r = await api(env, "PUT", `/prefs/topology/${LAB}`, b);
      expect(r.status, field).toBe(400);
      expect(r.json.error, field).toMatchObject({ code: "bad_input", field });
    }
    expect((await putRaw(env, LAB, "not json")).status).toBe(400);
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("a body over 20 KiB is refused before parsing", async () => {
    const { env } = apiEnv();
    // Not even JSON: refused for its size, not its shape.
    const big = "x".repeat(MAX_TOPOLOGY_BODY_BYTES + 1);
    const r = await putRaw(env, LAB, big);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: "bad_input", field: "layout" });
    expect(r.json.error.message).toMatch(/too large/i);
    // A declared length over the cap is refused too.
    const d = await putRaw(env, LAB, "{}", { "Content-Length": String(MAX_TOPOLOGY_BODY_BYTES + 1) });
    expect(d.status).toBe(400);
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("a stored layout over 16 KiB is refused", async () => {
    const { env } = apiEnv();
    // 300 entries with long keys: under the 20 KiB body cap? No, so build one under the body cap but over 16 KiB stored.
    const nodes: TopologyLayout["nodes"] = {};
    for (let i = 0; i < 160; i++) nodes[`microsoft.network/virtualnetworks/subnets/vnet-${String(i).padStart(3, "0")}/snet-abcdefghij`] = { x: 100_000, y: -100_000, p: null };
    const body = JSON.stringify({ baseVersion: 0, layout: { v: 1, nodes } });
    expect(body.length).toBeLessThan(MAX_TOPOLOGY_BODY_BYTES);
    expect(body.length).toBeGreaterThan(16 * 1024);
    const r = await putRaw(env, LAB, body);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: "bad_input", field: "layout" });
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("PUT without same-origin is refused", async () => {
    const { env } = apiEnv();
    const r = await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 0, layout: one }, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(await count(env, "ui_prefs")).toBe(0);
  });

  it("GET /api/v1/prefs still answers the five widget pages only", async () => {
    const { env } = apiEnv();
    await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 0, layout: one });
    const r = await api(env, "GET", "/prefs");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.pages)).toEqual(["overview", "clients", "firewall", "activity", "cost"]);
    // And the widget PUT does not take a topology page.
    expect((await api(env, "PUT", `/prefs/topology:${LAB}`, { schema: 2, baseVersion: 0, prefs: {} })).status).toBe(404);
  });

  it("layouts are per user", async () => {
    const { env } = makeEnv();
    const A = "a@example.com";
    const B = "b@example.com";
    const a = await putTopologyLayout(env, A, LAB, 0, one);
    expect(a).toMatchObject({ ok: true, page: { version: 1, layout: one } });
    expect(await getTopologyLayout(env, B, LAB)).toEqual({ version: 0, updatedAt: null, layout: EMPTY_LAYOUT });
    expect(await putTopologyLayout(env, B, LAB, 0, EMPTY_LAYOUT)).toMatchObject({ ok: true, page: { version: 1 } });
    expect(await getTopologyLayout(env, A, LAB)).toMatchObject({ version: 1, layout: one });
    // Another lab is another row.
    expect(await getTopologyLayout(env, A, "az700-43-private-link")).toMatchObject({ version: 0 });
    expect((await getPrefs(env, A)).pages).not.toHaveProperty(`topology:${LAB}`);
  });

  it("getPrefs reads only widget rows: a person's topology rows (up to 16 KiB each) are never fetched", async () => {
    const { env } = makeEnv();
    const A = "a@example.com";
    await putTopologyLayout(env, A, LAB, 0, one);
    await putTopologyLayout(env, A, "az700-43-private-link", 0, one);
    const read: { sql: string; rows: { page: string }[] }[] = [];
    const real = env.DB;
    const spy = {
      ...real,
      prepare: (sql: string) => {
        const st = real.prepare(sql);
        return {
          bind: (...args: unknown[]) => {
            const b = st.bind(...args);
            return {
              ...b,
              all: async <T,>() => {
                const r = await b.all<T>();
                read.push({ sql, rows: r.results as { page: string }[] });
                return r;
              },
              first: b.first.bind(b),
              run: b.run.bind(b),
            };
          },
        };
      },
    } as unknown as D1Database;
    const got = await getPrefs({ ...env, DB: spy } as Env, A);
    expect(Object.keys(got.pages)).toEqual(["overview", "clients", "firewall", "activity", "cost"]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.flatMap((r) => r.rows.map((x) => x.page)).filter((p) => p.startsWith("topology:"))).toEqual([]);
  });

  it("an unreadable stored row reads as an empty layout at its version", async () => {
    const { env } = makeEnv();
    await env.DB.prepare("INSERT INTO ui_prefs (user, page, json, version, updated_at) VALUES ('a@example.com', ?1, 'not json', 3, '2026-10-01T00:00:00.000Z')").bind(`topology:${LAB}`).run();
    expect(await getTopologyLayout(env, "a@example.com", LAB)).toEqual({ version: 3, updatedAt: "2026-10-01T00:00:00.000Z", layout: EMPTY_LAYOUT });
  });

  it("backup export leaves ui_prefs out, topology rows included", async () => {
    const { env } = apiEnv();
    await api(env, "PUT", `/prefs/topology/${LAB}`, { baseVersion: 0, layout: one });
    expect(Object.values(EXPORT_TABLES)).not.toContain("ui_prefs");
    const exp = JSON.stringify(await buildExport(env));
    expect(exp).not.toContain("topology:");
    expect(exp).not.toContain("vm-web");
  });
});
