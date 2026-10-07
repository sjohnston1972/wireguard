// labs-contract.test.ts
//
// Plain English: the lab contract's Worker side (plan L0.3): the tables of
// migration 0020, the per-lab run lock, the API's stubs and their input
// checks, the token-checked callbacks, the cron order, the Labs firewall
// zone, the one-time phone links for labs, the harness's fake Azure and Graph
// and the dev seed. The engine (L2) replaces the stubs; these shapes stay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { makeEnv } from "./harness";
import { api, apiEnv } from "./api-helpers";
import worker from "../src/index";
import type { Env } from "../src/env";
import { acquireLock, lockStatus, releaseLock, labLock } from "../src/lock";
import { actionButton, consumeAction } from "../src/actions";
import { catalogue, labDef, setCatalogueForTest } from "../src/labs/catalogue";
import { zoneAddrs, ZONE_LABEL, compileFirewall, type FwRule } from "../src/firewall";
import { config } from "../src/env";
import { SCENARIOS } from "../src/devseed";
import { LAB_POOL, LAB_SLOTS, slotCidr, type LabCatalogue } from "../../shared/labs";
import type { LabsResponse, LabCoverageResponse, LabSessionsResponse, LabDetail } from "../../shared/api";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const EMPTY: LabCatalogue = { schema: 2, skillAreas: [], labs: [], readmes: {}, learning: {}, resources: {} };
const base = "http://localhost:8787";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rows = async <T>(env: Env, sql: string) => (await env.DB.prepare(sql).all<T>()).results;

// ── Storage ──────────────────────────────────────────────────────────────

describe("migration 0020", () => {
  it("migration 0020 creates the lab tables and seeds 32 slots", async () => {
    const { env } = makeEnv();
    const tables = (await rows<{ name: string }>(env, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lab_%' ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual(["lab_cost_days", "lab_release_tests", "lab_runs", "lab_sessions", "lab_slots"]);
    const slots = await rows<{ slot: number; cidr: string; session_id: string | null }>(env, "SELECT slot, cidr, session_id FROM lab_slots ORDER BY slot");
    expect(slots).toHaveLength(LAB_SLOTS);
    slots.forEach((s, n) => expect(s).toEqual({ slot: n, cidr: slotCidr(n), session_id: null }));
    // The spec's columns, exactly.
    const cols = async (t: string) => (await rows<{ name: string }>(env, `PRAGMA table_info(${t})`)).map((r) => r.name);
    expect(await cols("lab_sessions")).toEqual(["id", "lab_id", "lab_version", "state", "test", "region", "secondary_region", "slot", "cidr", "name_prefix", "peering", "requested_at", "ready_at", "ended_at", "auto_destroy_at", "max_until", "warned_at", "est_gbp_h", "est_gbp", "end_reason", "outputs_json", "leftovers_json", "note"]);
    expect(await cols("lab_runs")).toEqual(["id", "session_id", "lab_id", "action", "status", "requested_at", "requested_by", "reason", "started_at", "finished_at", "github_run_id", "github_run_url", "callback_token_hash", "admin_password", "payload_json", "outputs_json", "steps_json", "error"]);
    expect(await cols("lab_cost_days")).toEqual(["day", "rg", "lab_id", "gbp", "fetched_at"]);
    expect(await cols("lab_release_tests")).toEqual(["lab_id", "version", "at", "run_id", "result", "deploy_seconds", "destroy_seconds", "est_gbp", "leftovers_json"]);
    expect(await cols("peers")).toContain("labs_config_due");
  });

  it("the slot reservation statement takes the lowest free slot, once", async () => {
    const { env } = makeEnv();
    const take = (sid: string) => env.DB.prepare("UPDATE lab_slots SET session_id = ?1, since = ?2 WHERE slot = (SELECT MIN(slot) FROM lab_slots WHERE session_id IS NULL) AND session_id IS NULL RETURNING slot, cidr").bind(sid, "2026-10-04T12:00:00Z").first<{ slot: number; cidr: string }>();
    expect(await take("ls-a")).toEqual({ slot: 0, cidr: "10.64.0.0/18" });
    expect(await take("ls-b")).toEqual({ slot: 1, cidr: "10.64.64.0/18" });
  });

  it("labs_config_due is set for split-tunnel azure_vnet clients only", () => {
    const db = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf("0020_labs.sql");
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) db.exec(readFileSync(new URL(f, dir), "utf8"));
    const add = (name: string, ip: string, full: number, azure: number, routes = "") =>
      db.prepare("INSERT INTO peers (name, public_key, ip, full_tunnel, azure_vnet, routes, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00Z')").run(name, `key-${name}`, ip, full, azure, routes);
    add("split-azure", "10.13.13.2", 0, 1);
    add("split-plain", "10.13.13.3", 0, 0);
    add("full-azure", "10.13.13.4", 1, 1);
    add("site", "10.13.13.5", 0, 1, "192.168.1.0/24");
    db.exec(readFileSync(new URL("0020_labs.sql", dir), "utf8"));
    const due = db.prepare("SELECT name, labs_config_due AS d FROM peers ORDER BY id").all();
    expect(due.map((r) => [r.name, r.d])).toEqual([["split-azure", 1], ["split-plain", 0], ["full-azure", 0], ["site", 0]]);
  });
});

// ── Locks ────────────────────────────────────────────────────────────────

describe("locks", () => {
  it("RunLock lab:<id> and singleton are independent", async () => {
    const { env } = makeEnv();
    expect(labLock("az104-05-storage")).toBe("lab:az104-05-storage");
    expect((await acquireLock(env, "run-gw")).ok).toBe(true);
    expect((await acquireLock(env, "lab-deploy-1", { name: labLock("az104-05-storage"), ttlMs: 60_000 })).ok).toBe(true);
    expect((await acquireLock(env, "lab-deploy-2", { name: labLock("az104-06-blob-security") })).ok).toBe(true);
    // The same lab's lock is taken; the gateway's is untouched by labs.
    const again = await acquireLock(env, "lab-deploy-3", { name: labLock("az104-05-storage") });
    expect(again).toMatchObject({ ok: false, holder: { runId: "lab-deploy-1" } });
    expect((await lockStatus(env)).lock?.runId).toBe("run-gw");
    expect((await lockStatus(env, labLock("az104-05-storage"))).lock?.runId).toBe("lab-deploy-1");
    // Releasing a lab's lock leaves the others.
    await releaseLock(env, "lab-deploy-1", false, labLock("az104-05-storage"));
    expect((await lockStatus(env, labLock("az104-05-storage"))).held).toBe(false);
    expect((await lockStatus(env)).held).toBe(true);
    expect((await lockStatus(env, labLock("az104-06-blob-security"))).held).toBe(true);
    await releaseLock(env, "run-gw");
    expect((await lockStatus(env)).held).toBe(false);
  });

  it("a lab lock's TTL is the caller's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const { env } = makeEnv();
    await acquireLock(env, "lab-x", { name: "lab:az104-05-storage", ttlMs: 49 * 60_000 });
    expect((await lockStatus(env, "lab:az104-05-storage")).lock?.expiresAt).toBe(Date.parse("2026-10-04T12:49:00Z"));
  });
});

// ── The catalogue ────────────────────────────────────────────────────────

describe("catalogue", () => {
  it("is the generated one unless a test sets its own", () => {
    expect(catalogue().schema).toBe(2);
    // Every real lab has a planned diagram, so resources (labs redesign spec §6.2).
    expect(catalogue().resources["az104-06-blob-security"]).toMatchObject({ storage: 1, privateEndpoint: 1 });
    expect(catalogue().labs.map((l) => l.id)).toContain("az104-06-blob-security");
    expect(labDef("az104-06-blob-security")?.number).toBe(6);
    setCatalogueForTest(EMPTY);
    expect(catalogue()).toBe(EMPTY);
    expect(labDef("az104-06-blob-security")).toBeNull();
    setCatalogueForTest(null);
    expect(labDef("az104-06-blob-security")?.number).toBe(6);
  });
});

// ── The API ──────────────────────────────────────────────────────────────

describe("/api/v1/labs with an empty catalogue", () => {
  beforeEach(() => setCatalogueForTest(EMPTY));

  it("every /api/v1/labs route answers its shape with an empty catalogue", async () => {
    const { env } = apiEnv();
    const list = await api(env, "GET", "/labs");
    expect(list.status).toBe(200);
    const l = list.json as LabsResponse;
    expect(l).toMatchObject({ labs: [], running: [], slots: { used: 0, total: 32 }, maxRunning: 3, orphans: [] });
    expect(l.permissions).toEqual({ checkedAt: null, role: null, users: null, groups: null, message: null });
    expect(typeof l.now).toBe("string");
    expect(((await api(env, "GET", "/labs/sessions")).json as LabSessionsResponse).sessions).toEqual([]);
    expect(((await api(env, "GET", "/labs/sessions?lab=az104-05-storage&limit=10")).json as LabSessionsResponse).sessions).toEqual([]);
    expect(((await api(env, "GET", "/labs/coverage")).json as LabCoverageResponse).exams).toEqual([]);
    // A lab the catalogue does not have.
    for (const [m, p, b] of [
      ["GET", "/labs/az104-05-storage", undefined],
      ["GET", "/labs/az104-05-storage/secret", undefined],
      ["POST", "/labs/az104-05-storage/deploy", { hours: 2, peer: false }],
      ["POST", "/labs/az104-05-storage/extend", { hours: 1 }],
      ["POST", "/labs/az104-05-storage/destroy", { confirm: true }],
      ["POST", "/labs/az104-05-storage/peer", undefined],
      ["POST", "/labs/az104-05-storage/unpeer", undefined],
      ["POST", "/labs/az104-05-storage/test", undefined],
      ["POST", "/labs/az104-05-storage/cancel", undefined],
      ["PUT", "/labs/sessions/ls-20261004120000-abcd/note", { note: "hi" }],
    ] as const) {
      const r = await api(env, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json.error.code, `${m} ${p}`).toBe("not_found");
    }
    // Nothing waits to re-peer; the engine (L2) checks permissions, and knows no leftovers of a lab it has not got.
    expect(await api(env, "POST", "/labs/repeer")).toMatchObject({ status: 200, json: { ok: true } });
    expect((await api(env, "POST", "/labs/permissions/check")).status).toBe(200);
    expect((await api(env, "POST", "/labs/orphans/cleanup", { lab_id: "az104-05-storage" })).status).toBe(404);
  });

  it("the existing answers carry the lab fields with nothing in them", async () => {
    const { env } = apiEnv();
    expect((await api(env, "GET", "/overview")).json.labs).toEqual({ running: [], gbpH: 0, rePeer: 0 });
    expect((await api(env, "GET", "/cost")).json.labs).toEqual([]);
    expect((await api(env, "GET", "/settings")).json.values).toMatchObject({ labsMaxRunning: 3, labsDefaultPeering: true });
    await api(env, "POST", "/clients", { name: "laptop", public_key: "Vf3o2tQm7bJt3Q8Gq7mKX2c8M3Yw0vJ5bL1sQ9rT6nE=", azure_vnet: true });
    const clients = (await api(env, "GET", "/clients")).json.clients;
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) expect(c.labsConfigDue).toBe(false);
  });
});

describe("/api/v1/labs input checks", () => {
  it("deploy body refuses unknown keys and hours outside 1–12 with field", async () => {
    const { env } = apiEnv();
    const deploy = (b: unknown) => api(env, "POST", "/labs/az104-06-blob-security/deploy", b);
    const field = async (b: unknown) => {
      const r = await deploy(b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.code).toBe("bad_input");
      return r.json.error.field;
    };
    expect(await field({ hours: 2, peer: true, colour: "blue" })).toBe("colour");
    expect(await field({ hours: 0, peer: true })).toBe("hours");
    expect(await field({ hours: 13, peer: true })).toBe("hours");
    expect(await field({ hours: 1.5, peer: true })).toBe("hours");
    expect(await field({ hours: "2", peer: true })).toBe("hours");
    expect(await field({ peer: true })).toBe("hours");
    expect(await field({ hours: 2 })).toBe("peer");
    expect(await field({ hours: 2, peer: "yes" })).toBe("peer");
    expect(await field({ hours: 2, peer: true, region: "UK South" })).toBe("region");
    expect(await field({ hours: 2, peer: true, overBudgetOk: 1 })).toBe("overBudgetOk");
    expect(await field({ hours: 2, peer: true, capacityOk: "true" })).toBe("capacityOk");
    // A good body reaches the engine (L2), which refuses it here: the permission check has not run.
    const engine = await deploy({ hours: 2, peer: true, region: "uksouth", overBudgetOk: true, capacityOk: false });
    expect(engine.status).toBe(409);
    expect(engine.json.error.code).toBe("unavailable");
  });

  it("the other bodies refuse what they do not take, each with its field", async () => {
    const { env } = apiEnv();
    const f = async (m: string, p: string, b: unknown) => {
      const r = await api(env, m, p, b);
      expect(r.status, `${p} ${JSON.stringify(b)}`).toBe(400);
      return r.json.error.field;
    };
    const lab = "/labs/az104-06-blob-security";
    expect(await f("POST", `${lab}/extend`, { hours: 0 })).toBe("hours");
    expect(await f("POST", `${lab}/extend`, { hours: 1, toMax: true })).toBe("toMax");
    expect(await f("POST", `${lab}/extend`, { toMax: false })).toBe("toMax");
    expect(await f("POST", `${lab}/extend`, {})).toBe("hours");
    expect(await f("POST", `${lab}/destroy`, { confirm: "yes" })).toBe("confirm");
    expect(await f("POST", `${lab}/destroy`, {})).toBe("confirm");
    expect(await f("POST", `${lab}/peer`, { now: true })).toBe("now");
    expect(await f("POST", `${lab}/test`, { force: true })).toBe("force");
    expect(await f("PUT", "/labs/sessions/ls-x/note", { note: "x".repeat(2001) })).toBe("note");
    expect(await f("PUT", "/labs/sessions/ls-x/note", { note: 5 })).toBe("note");
    expect(await f("PUT", "/labs/sessions/ls-x/note", { note: "ok", extra: 1 })).toBe("extra");
    expect(await f("POST", "/labs/orphans/cleanup", { lab_id: "rg-wg-ondemand" })).toBe("lab_id");
    expect(await f("POST", "/labs/orphans/cleanup", {})).toBe("lab_id");
    expect(await f("POST", "/labs/repeer", { all: true })).toBe("all");
    expect(await f("GET", "/labs/sessions?limit=0", undefined)).toBe("limit");
    expect(await f("GET", "/labs/sessions?limit=201", undefined)).toBe("limit");
    expect(await f("GET", "/labs/sessions?lab=rg-wg", undefined)).toBe("lab");
    // A malformed lab id is simply not found.
    expect((await api(env, "GET", "/labs/AZ104-x")).status).toBe(404);
  });

  it("a lab in the catalogue answers its detail; actions reach the engine stub", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/labs/az104-06-blob-security");
    expect(r.status).toBe(200);
    const d = r.json as LabDetail;
    expect(d.card).toMatchObject({ id: "az104-06-blob-security", number: 6, running: null, released: false, marker: "£" });
    expect(d.card.estGbpH).toBeCloseTo(0.0082, 6);
    // An introduction first (the modal shows the title), then What it deploys.
    expect(d.readme[0].t).toBe("p");
    expect(d.readme.find((b) => b.t === "h")).toEqual({ t: "h", level: 2, text: "What it deploys" });
    expect(d.cost.items.map((i) => i.source)).toEqual(["authored", "authored", "authored"]);
    expect(d.cost.items[1].priceAge).toBeNull();
    expect(d.defaults).toEqual({ region: "uksouth", peer: true, hours: 2 });
    expect(d).toMatchObject({ session: null, runs: [], resources: null, portalUrl: null });
    // The engine (L2): lab 6 makes an Entra group, and the permission check has not run.
    expect(d.warnings.map((w) => [w.kind, w.overridable])).toEqual([["unavailable", false]]);
    expect((await api(env, "GET", "/labs/az104-06-blob-security/secret")).status).toBe(409);
    // Nothing is running, so the engine (L2) refuses the tear-down.
    expect((await api(env, "POST", "/labs/az104-06-blob-security/destroy", { confirm: true })).status).toBe(409);
    const cards = (await api(env, "GET", "/labs")).json as LabsResponse;
    expect(cards.labs.map((c) => c.id)).toEqual(catalogue().labs.map((l) => l.id));
    const cov = (await api(env, "GET", "/labs/coverage")).json as LabCoverageResponse;
    // Every exam with skill areas, AZ-700 the third (ruling 38).
    expect(cov.exams.map((e) => e.exam)).toEqual(["AZ-104", "AZ-305", "AZ-700"]);
    const storage = cov.exams[0].areas.find((a) => a.key === "az104.storage")!;
    expect(storage).toMatchObject({ run: 0, available: 3 });
  });
});

// ── Callbacks ────────────────────────────────────────────────────────────

describe("callbacks", () => {
  const post = (env: Env, path: string, token?: string) =>
    worker.fetch(new Request(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ run_id: "lab-deploy-x" }) }), env, ctx);

  it("callback stubs need a token", async () => {
    const { env } = makeEnv({ PUBLIC_URL: base });
    for (const p of ["/api/callback/lab", "/api/callback/lab-secrets", "/api/callback/lab-peer", "/api/callback/lab-peerings-removed"]) {
      const none = await post(env, p);
      expect(none.status, p).toBe(401);
      // With a token, the engine (L2) answers: never a success for a run it does not know or a token it cannot verify.
      const some = await post(env, p, "a-token");
      expect(some.status, p).toBeGreaterThanOrEqual(400);
    }
  });
});

// ── The cron ─────────────────────────────────────────────────────────────

describe("scheduled()", () => {
  it("a lab watch that throws still lets the watchman and insights run", async () => {
    const order: string[] = [];
    vi.resetModules();
    vi.doMock("../src/monitor", async (orig) => ({ ...(await orig<object>()), runScheduled: async () => (order.push("watchman"), []) }));
    vi.doMock("../src/labs/watch", () => ({ runLabWatch: async () => (order.push("labs"), Promise.reject(new Error("boom"))) }));
    vi.doMock("../src/insights/runner", async (orig) => ({ ...(await orig<object>()), runInsights: async () => (order.push("insights"), []) }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fresh = (await import("../src/index")).default;
      const { env } = makeEnv();
      const waits: Promise<unknown>[] = [];
      await fresh.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
      await Promise.all(waits);
      expect(order).toEqual(["watchman", "labs", "insights"]);
      expect(errors.mock.calls.some((c) => String(c[0]).includes("lab watch"))).toBe(true);
    } finally {
      errors.mockRestore();
      vi.doUnmock("../src/monitor");
      vi.doUnmock("../src/labs/watch");
      vi.doUnmock("../src/insights/runner");
      vi.resetModules();
    }
  });

  it("a watchman that throws still lets the lab watch and insights run", async () => {
    const order: string[] = [];
    vi.resetModules();
    vi.doMock("../src/monitor", async (orig) => ({ ...(await orig<object>()), runScheduled: async () => (order.push("watchman"), Promise.reject(new Error("boom"))) }));
    vi.doMock("../src/labs/watch", () => ({ runLabWatch: async () => (order.push("labs"), []) }));
    vi.doMock("../src/insights/runner", async (orig) => ({ ...(await orig<object>()), runInsights: async () => (order.push("insights"), []) }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fresh = (await import("../src/index")).default;
      const { env } = makeEnv();
      const waits: Promise<unknown>[] = [];
      await fresh.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
      await Promise.all(waits);
      expect(order).toEqual(["watchman", "labs", "insights"]);
    } finally {
      errors.mockRestore();
      vi.doUnmock("../src/monitor");
      vi.doUnmock("../src/labs/watch");
      vi.doUnmock("../src/insights/runner");
      vi.resetModules();
    }
  });
});

// ── One-time phone links ─────────────────────────────────────────────────

describe("lab one-time links", () => {
  it("QuickAction takes lab-extend-1h:<sid> and lab-destroy:<sid>, and /api/act sends them to labs/act.ts once", async () => {
    const { env } = makeEnv({ PUBLIC_URL: base });
    const b = await actionButton(env, "lab-destroy:ls-20261004120000-abcd", 600);
    expect(b.label).toBe("Tear down");
    expect((await actionButton(env, "lab-extend-1h:ls-20261004120000-abcd", 600)).label).toBe("Extend 1h");
    const token = b.url.split("/").pop()!;
    const first = await worker.fetch(new Request(`${base}/api/act/${token}`, { method: "POST" }), env, ctx);
    expect(first.status).toBe(200);
    expect(await first.text()).toMatch(/lab/i);
    const again = await worker.fetch(new Request(`${base}/api/act/${token}`, { method: "POST" }), env, ctx);
    expect(again.status).toBe(410);
    // A forged action never comes back out of the store.
    const c = await actionButton(env, "extend", 600);
    expect(await consumeAction(env, c.url.split("/").pop()!)).toBe("extend");
  });
});

// ── The Labs firewall zone ───────────────────────────────────────────────

describe("firewall", () => {
  it("the Labs zone is in zoneAddrs and internet no longer matches 10.64.1.1", async () => {
    const { env } = makeEnv();
    const cfg = config(env);
    expect(ZONE_LABEL.labs).toBe("Labs");
    expect(zoneAddrs("labs", cfg)).toEqual({ v4: [LAB_POOL], v6: [] });
    const internet = zoneAddrs("internet", cfg);
    expect(internet.negate).toBe(true);
    expect(internet.v4).toContain(LAB_POOL);
    const rule: FwRule = { id: 1, position: 10, enabled: 1, name: "to the internet", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet", proto: "any", ports: "", action: "allow", log: 0 };
    const { text } = await compileFirewall([rule], cfg, [], "deny");
    expect(text).toMatch(/ip daddr != \{[^}]*10\.64\.0\.0\/13[^}]*\}/);
    const toLabs: FwRule = { ...rule, id: 2, dst_value: "labs" };
    expect((await compileFirewall([toLabs], cfg, [], "deny")).text).toContain("ip daddr 10.64.0.0/13");
  });
});

// ── The harness's fake world ─────────────────────────────────────────────

describe("harness", () => {
  it("records each dispatch's workflow and titles lab runs as lab.yml does", async () => {
    const { env, world } = makeEnv();
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/lab.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { action: "deploy", payload: JSON.stringify({ lab_id: "az104-05-storage", run_id: "lab-deploy-x" }) } }) });
    expect(r.status).toBe(204);
    expect(world.dispatches).toEqual([{ workflow: "lab.yml", action: "deploy", payload: { lab_id: "az104-05-storage", run_id: "lab-deploy-x" } }]);
    const runs = (await (await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/lab.yml/runs`)).json()) as any;
    expect(runs.workflow_runs.map((x: { display_title: string }) => x.display_title)).toEqual(["lab deploy az104-05-storage lab-deploy-x"]);
    // The gateway's workflow never lists lab runs.
    const gw = (await (await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/wg.yml/runs`)).json()) as any;
    expect(gw.workflow_runs).toEqual([]);
  });

  it("fakes ARM, Graph and Cost Management for labs, and counts every call", async () => {
    const { world } = makeEnv();
    world.labAzure.groups.push({ name: "rg-lab-az104-05-storage", createdTime: "2026-10-04T10:00:00Z" }, { name: "NetworkWatcherRG" });
    world.labAzure.resources.push({ name: "stl05abcde", type: "Microsoft.Storage/storageAccounts", resourceGroup: "rg-lab-az104-05-storage", provisioningState: "Succeeded" });
    world.labAzure.managementGroups.push({ name: "lab-az104-03-mgmt-groups-root" });
    world.labAzure.roleDefinitions.push({ id: "7331dcae-09d3-477e-8da7-2895697f0fc0", roleName: "lab-az104-01-identity-vm-operator" });
    world.labAzure.policyDefinitions.push({ name: "lab-az104-02-policy-require-costcentre-tag" });
    world.labAzure.policyAssignments.push({ name: "lab-az104-02-policy-tags", scope: "/subscriptions/sub/resourceGroups/rg-lab-az104-02-policy" });
    world.labAzure.roleAssignments.push({ principalId: "oid-1", roleDefinitionId: "/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/gov", scope: "/subscriptions/sub" });
    world.labAzure.costRows.push({ day: "2026-10-03", rg: "rg-lab-az104-05-storage", gbp: 0.01 }, { day: "2026-10-03", rg: "rg-wg-ondemand", gbp: 0.2 });
    world.graph.users.push({ id: "u1", displayName: "lab-az104-01-identity-ann", userPrincipalName: "lab-az104-01-identity-ann@contoso.onmicrosoft.com" }, { id: "u2", displayName: "Steven", userPrincipalName: "steven@contoso.onmicrosoft.com" });
    world.graph.groups.push({ id: "g1", displayName: "lab-az104-01-identity-helpdesk", mailNickname: "lab-az104-01-identity-helpdesk" });
    const arm = async (path: string, init?: RequestInit): Promise<any> => (await fetch(`https://management.azure.com${path}`, init)).json();
    expect((await arm("/subscriptions/sub/resourcegroups?api-version=2021-04-01")).value.map((g: { name: string }) => g.name)).toEqual(["rg-lab-az104-05-storage", "NetworkWatcherRG"]);
    expect((await arm("/subscriptions/sub/resourceGroups/rg-lab-az104-05-storage/resources?api-version=2021-04-01")).value[0]).toMatchObject({ name: "stl05abcde", properties: { provisioningState: "Succeeded" } });
    expect((await arm("/providers/Microsoft.Management/managementGroups?api-version=2021-04-01")).value[0].name).toBe("lab-az104-03-mgmt-groups-root");
    expect((await arm("/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter=type%20eq%20'CustomRole'")).value[0].properties.roleName).toBe("lab-az104-01-identity-vm-operator");
    expect((await arm("/subscriptions/sub/providers/Microsoft.Authorization/policyDefinitions?api-version=2023-04-01")).value[0].name).toBe("lab-az104-02-policy-require-costcentre-tag");
    expect((await arm("/subscriptions/sub/providers/Microsoft.Authorization/policyAssignments?api-version=2023-04-01")).value[0].properties.scope).toContain("rg-lab-az104-02-policy");
    expect((await arm("/subscriptions/sub/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=principalId%20eq%20'oid-1'")).value).toHaveLength(1);
    const cost = await arm("/subscriptions/sub/providers/Microsoft.CostManagement/query?api-version=2023-03-01", { method: "POST", body: JSON.stringify({ dataset: { grouping: [{ type: "Dimension", name: "ResourceGroupName" }] } }) });
    expect(cost.properties.columns.map((c: { name: string }) => c.name)).toEqual(["Cost", "UsageDate", "ResourceGroupName", "Currency"]);
    expect(cost.properties.rows).toEqual([[0.01, 20261003, "rg-lab-az104-05-storage", "GBP"], [0.2, 20261003, "rg-wg-ondemand", "GBP"]]);
    const graph = async (path: string): Promise<any> => (await fetch(`https://graph.microsoft.com/v1.0${path}`)).json();
    expect((await graph("/users?$filter=startswith(displayName,'lab-')")).value.map((u: { id: string }) => u.id)).toEqual(["u1"]);
    expect((await graph("/users?$top=1")).value).toHaveLength(1);
    expect((await graph("/groups?$filter=startswith(displayName,'lab-')")).value.map((g: { id: string }) => g.id)).toEqual(["g1"]);
    const token = (await (await fetch("https://login.microsoftonline.com/t/oauth2/v2.0/token", { method: "POST", body: "scope=https://graph.microsoft.com/.default" })).json()) as any;
    expect(token.access_token).toBeTruthy();
    world.graph.fail = 403;
    expect((await fetch("https://graph.microsoft.com/v1.0/users?$top=1")).status).toBe(403);
    expect(world.calls.filter((c) => c.host === "management.azure.com")).toHaveLength(8);
    expect(world.calls.filter((c) => c.host === "graph.microsoft.com")).toHaveLength(4);
  });
});

// ── The dev seed ─────────────────────────────────────────────────────────

describe("devseed labs", () => {
  const NOW = "2026-10-04T14:00:00.000Z";
  const seed = async (env: Env, scenario: string) => {
    const r = await worker.fetch(new Request(`${base}/__dev/seed?scenario=${scenario}&now=${NOW}`, { method: "POST" }), env, ctx);
    expect(r.status, await r.clone().text()).toBe(200);
  };

  it("devseed labs fills the lab tables and every story wipes them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    expect(SCENARIOS).toContain("labs");
    const { env } = apiEnv();
    await seed(env, "labs");
    const sessions = await rows<{ lab_id: string; state: string; peering: string; note: string | null; end_reason: string | null; slot: number | null }>(env, "SELECT * FROM lab_sessions ORDER BY requested_at");
    const live = sessions.filter((s) => s.state === "running" || s.state === "deploying" || s.state === "tearing_down");
    expect(live.map((s) => [s.lab_id, s.state, s.peering]).sort()).toEqual([["az104-02-policy", "tearing_down", "off"], ["az104-05-storage", "deploying", "off"], ["az104-06-blob-security", "running", "on"]]);
    expect(sessions.filter((s) => s.state === "ended")).toHaveLength(8);
    expect(sessions.filter((s) => s.state === "ended" && s.note).length).toBeGreaterThan(0);
    expect(sessions.filter((s) => s.state === "ended_dirty")).toHaveLength(1);
    // Slots held: the three live sessions and the dirty one.
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL"))[0].n).toBe(4);
    // Lab 2 is tearing down at its timer: its destroy run is going.
    expect((await rows<{ action: string; status: string }>(env, "SELECT action, status FROM lab_runs WHERE lab_id = 'az104-02-policy' AND status = 'running'"))).toEqual([{ action: "destroy", status: "running" }]);
    // Three live sessions: room for a fourth, so the catalogue still offers Deploy.
    expect((await rows<{ value: string }>(env, "SELECT value FROM settings WHERE key = 'labs_max_running'"))[0]?.value).toBe("4");
    // Lab 5's deploy run is at step 7 of 16.
    const run = (await rows<{ steps_json: string; status: string }>(env, "SELECT steps_json, status FROM lab_runs WHERE lab_id = 'az104-05-storage' AND status = 'running'"))[0];
    const steps = JSON.parse(run.steps_json) as { status: string }[];
    expect(steps).toHaveLength(16);
    expect(steps.filter((s) => s.status === "completed")).toHaveLength(6);
    expect(steps[6].status).toBe("in_progress");
    expect((await rows<{ lab_id: string }>(env, "SELECT DISTINCT lab_id FROM lab_release_tests ORDER BY lab_id")).map((r) => r.lab_id)).toEqual(["az104-04-cost", "az104-05-storage", "az104-06-blob-security", "az104-07-files"]);
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_cost_days"))[0].n).toBeGreaterThan(0);
    // The orphan note, in the bell and in KV.
    const orphans = JSON.parse((await env.STATUS.get("labs:orphans")) ?? "[]");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].names.length).toBeGreaterThan(0);
    expect((await rows<{ message: string }>(env, "SELECT message FROM alerts WHERE message LIKE 'Lab leftovers:%'"))).toHaveLength(1);
    // No admin password survives an ended session, and every seeded run link is the fake CI host.
    expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_runs r JOIN lab_sessions s ON s.id = r.session_id WHERE s.state LIKE 'ended%' AND r.admin_password IS NOT NULL"))[0].n).toBe(0);
    for (const r of await rows<{ github_run_url: string | null }>(env, "SELECT github_run_url FROM lab_runs")) if (r.github_run_url) expect(r.github_run_url).toMatch(/^https:\/\/ci\.example\.invalid\/actions\/runs\/\d+$/);

    for (const story of SCENARIOS.filter((s) => s !== "labs")) {
      await seed(env, "labs");
      await seed(env, story);
      for (const t of ["lab_sessions", "lab_runs", "lab_cost_days", "lab_release_tests"]) expect((await rows<{ n: number }>(env, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, `${story} ${t}`).toBe(0);
      expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots WHERE session_id IS NOT NULL"))[0].n, story).toBe(0);
      expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM lab_slots"))[0].n).toBe(32);
      expect(await env.STATUS.get("labs:orphans"), story).toBeNull();
      expect((await rows<{ n: number }>(env, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'labs_%'"))[0].n, story).toBe(0);
    }
  }, 30_000);
});
