// insights-contract.test.ts
//
// Plain English: the contract the Azure insights areas build on (plan
// 2026-10-04-azure-insights-plan.md, X0.4). The tables exist (migration
// 0019), the second cron reaches the collector and only the collector,
// every /api/v1/azure route answers its spec section 8 shape without asking
// Azure anything, and the dev seeder knows the new tables and the
// `insights` story.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { makeEnv } from "./harness";
import { api, apiEnv } from "./api-helpers";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SCENARIOS } from "../src/devseed";
import { getSnapshot } from "../src/state";
import { AZURE_METRICS, AZURE_RESOURCE_KINDS, FEEDS, PIP_COLUMNS, STALE_CADENCES, VITALS_COLUMNS, VM_COLUMNS, azureMetricNames, feedIsStale, metricByColumn } from "../../shared/azureMetrics";
import { AZ_RUN_BUDGET, AZ_TABLES, BudgetExceeded, FEED_IDS, FEED_TITLES, INSIGHTS_CRON, WATCHMAN_CRON, insightsConfigured, makeBudget } from "../src/insights/types";

vi.mock("../src/insights/runner", () => ({ runInsights: vi.fn(async () => ["insights ran"]) }));
vi.mock("../src/monitor", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/monitor")>()), runScheduled: vi.fn(async () => []) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const NO_AZURE: Partial<Env> = { AZURE_TENANT_ID: undefined, AZURE_CLIENT_ID: undefined, AZURE_CLIENT_SECRET: undefined, AZURE_SUBSCRIPTION_ID: undefined };

async function columns(env: Env, table: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);
}

describe("migration 0019", () => {
  it("migration 0019 creates the az tables, hist_az_vm, hist_az_pip and the hist_vm vitals columns", async () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.at(-1)).toBe("0019_azure_insights.sql");
    const { env } = makeEnv();
    expect(await columns(env, "hist_vm")).toEqual(expect.arrayContaining(["mem_used_pct", "disk_used_pct", "steal_pct", "conntrack_pct", "net_rtt_ms", "net_loss_pct"]));
    expect(await columns(env, "hist_az_vm")).toEqual(["res", "t", "cpu_avg", "cpu_max", "mem_free_min", "net_in", "net_out", "disk_read", "disk_write", "disk_rops", "disk_wops", "credits_min", "credits_used", "avail_avg", "os_iops_max", "os_bw_max"]);
    expect(await columns(env, "hist_az_pip")).toEqual(["res", "t", "ddos_max", "pkts_in_ddos", "pkts_drop_ddos", "bytes_in_ddos", "bytes_drop_ddos", "packets", "bytes", "syn", "vip_avail"]);
    expect(await columns(env, "az_feed")).toEqual(["feed", "last_try_at", "last_ok_at", "status", "error", "next_due_at"]);
    expect(await columns(env, "az_latest")).toEqual(["key", "json", "updated_at"]);
    expect(await columns(env, "az_activity")).toEqual(["id", "at", "correlation_id", "operation", "status", "caller", "caller_kind", "resource_type", "resource_name", "category", "level"]);
    expect(await columns(env, "az_service_events")).toEqual(["tracking_id", "type", "status", "level", "title", "summary", "services", "regions", "starts_at", "ends_at", "updated_at"]);
    expect(await columns(env, "az_capacity")).toEqual(["region", "json", "fetched_at"]);
    expect(await columns(env, "az_prices")).toEqual(["region", "item", "gbp", "unit", "meter", "fetched_at"]);
    // Every new table is WITHOUT ROWID, like hist_*; az_activity is indexed by time.
    const master = (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'az_%' OR name LIKE 'hist_az_%'").all<{ type: string; name: string; sql: string }>()).results;
    for (const t of AZ_TABLES) expect(master.find((m) => m.name === t && m.type === "table")?.sql, t).toMatch(/WITHOUT ROWID\s*$/);
    expect(master.some((m) => m.type === "index" && m.name === "az_activity_at")).toBe(true);
    expect([...AZ_TABLES].sort()).toEqual(["az_activity", "az_capacity", "az_feed", "az_latest", "az_prices", "az_service_events", "hist_az_pip", "hist_az_vm"]);
  });

  it("hist_az_vm keys on an INTEGER res: a REAL bind cast to INTEGER finds the same row", async () => {
    const { env } = makeEnv();
    const t = "2026-10-04T10:05:00.000Z";
    await env.DB.prepare("INSERT INTO hist_az_vm (res, t, cpu_avg) VALUES (CAST(?1 AS INTEGER), ?2, ?3)").bind(300, t, 12.5).run();
    await env.DB.prepare("INSERT INTO hist_az_vm (res, t, cpu_avg) VALUES (CAST(?1 AS INTEGER), ?2, ?3) ON CONFLICT (res, t) DO UPDATE SET cpu_avg = excluded.cpu_avg").bind(300.0, t, 20).run();
    expect((await env.DB.prepare("SELECT res, typeof(res) AS ty, cpu_avg FROM hist_az_vm").all()).results).toEqual([{ res: 300, ty: "integer", cpu_avg: 20 }]);
  });
});

describe("the metric catalogue (shared/azureMetrics.ts)", () => {
  it("maps every Azure metric to a plain title, a unit, its aggregation and a column of its table", async () => {
    const { env } = makeEnv();
    const vmCols = await columns(env, "hist_az_vm");
    const pipCols = await columns(env, "hist_az_pip");
    expect(["t", ...VM_COLUMNS]).toEqual(vmCols.slice(1));
    expect(["t", ...PIP_COLUMNS]).toEqual(pipCols.slice(1));
    expect(AZURE_METRICS.filter((m) => m.resource === "vm").map((m) => m.column).sort()).toEqual([...VM_COLUMNS].sort());
    expect(AZURE_METRICS.filter((m) => m.resource === "pip").map((m) => m.column).sort()).toEqual([...PIP_COLUMNS].sort());
    for (const m of AZURE_METRICS) {
      expect(m.title, m.column).toMatch(/^[A-Z]/);
      expect(m.unit, m.column).not.toBe("");
      expect(["Average", "Maximum", "Minimum", "Total"], m.column).toContain(m.aggregation);
    }
    expect(metricByColumn("cpu_avg")).toMatchObject({ name: "Percentage CPU", title: "CPU used", unit: "%", aggregation: "Average" });
    // One metrics call may ask for at most 20 names.
    expect(azureMetricNames("vm").length).toBe(13);
    expect(azureMetricNames("pip").length).toBe(9);
    // The vitals series are the new hist_vm columns.
    expect(await columns(env, "hist_vm")).toEqual(expect.arrayContaining([...VITALS_COLUMNS]));
    expect(VITALS_COLUMNS).toEqual(["mem_used_pct", "disk_used_pct", "steal_pct", "conntrack_pct", "net_rtt_ms", "net_loss_pct"]);
  });

  it("a feed is stale after 3 cadences; a feed that never worked, or runs on demand, is never stale", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const ago = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(STALE_CADENCES).toBe(3);
    expect(feedIsStale({ lastOkAt: ago(15), cadenceMin: 5 }, now)).toBe(false);
    expect(feedIsStale({ lastOkAt: ago(16), cadenceMin: 5 }, now)).toBe(true);
    expect(feedIsStale({ lastOkAt: ago(44), cadenceMin: 15 }, now)).toBe(false);
    expect(feedIsStale({ lastOkAt: ago(46), cadenceMin: 15 }, now)).toBe(true);
    expect(feedIsStale({ lastOkAt: null, cadenceMin: 5 }, now)).toBe(false);
    expect(feedIsStale({ lastOkAt: ago(10_000), cadenceMin: null }, now)).toBe(false);
    expect(feedIsStale({ lastOkAt: "garbage", cadenceMin: 5 }, now)).toBe(false);
    expect(FEEDS.map((f) => f.id)).toEqual(FEED_IDS);
  });

  it("names the Azure resource kinds the change log filters by, matching the widget's Types options", async () => {
    const { widgetDef } = await import("../../shared/widgets");
    const types = widgetDef("activity.azureChanges")!.settings.find((s) => s.key === "types") as { options: { value: string; label: string }[] };
    expect(AZURE_RESOURCE_KINDS.map((k) => ({ value: k.value, label: k.label }))).toEqual(types.options);
    expect(AZURE_RESOURCE_KINDS.map((k) => k.label)).toEqual(["Virtual machine", "Network security group", "Public IP", "Network interface", "Disk", "Virtual network", "Resource group", "Other"]);
  });
});

describe("the second cron", () => {
  it("wrangler.toml declares both crons", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/^crons = \["\*\/5 \* \* \* \*", "2-59\/5 \* \* \* \*"\]$/m);
    expect(WATCHMAN_CRON).toBe("*/5 * * * *");
    expect(INSIGHTS_CRON).toBe("2-59/5 * * * *");
  });

  it("scheduled() sends 2-59/5 to runInsights and */5 to the watchman", async () => {
    const { runInsights } = await import("../src/insights/runner");
    const { runScheduled } = await import("../src/monitor");
    const { env } = makeEnv();
    const run = async (cron: string) => {
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnCancel() {} } as unknown as ExecutionContext;
      await worker.scheduled!({ cron, scheduledTime: Date.parse("2026-10-04T10:07:00Z"), type: "scheduled", noRetry() {} } as unknown as ScheduledController, env, ctx);
      await Promise.all(waits);
    };
    await run(INSIGHTS_CRON);
    expect(runInsights).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runInsights).mock.calls[0]![0]).toBe(env);
    expect(vi.mocked(runInsights).mock.calls[0]![1]).toEqual(new Date("2026-10-04T10:07:00Z"));
    expect(runScheduled).not.toHaveBeenCalled();
    await run(WATCHMAN_CRON);
    expect(runScheduled).toHaveBeenCalledTimes(1);
    expect(runInsights).toHaveBeenCalledTimes(1);
    // A cron this Worker does not know (an old trigger left behind) is the watchman, as before this project.
    await run("0 * * * *");
    expect(runScheduled).toHaveBeenCalledTimes(2);
    expect(runInsights).toHaveBeenCalledTimes(1);
  });
});

describe("collector contract", () => {
  it("names nine feeds with plain titles, a 25-call budget, and a budget that throws BudgetExceeded past it", () => {
    expect(FEED_IDS).toEqual(["health", "vmMetrics", "pipMetrics", "metricDefs", "activity", "serviceHealth", "capacity", "prices", "bootLog"]);
    for (const id of FEED_IDS) expect(FEED_TITLES[id], id).toMatch(/^[A-Z][A-Za-z ]+$/);
    expect(AZ_RUN_BUDGET).toBe(25);
    const b = makeBudget(3);
    b.take(2);
    expect(b.remaining()).toBe(1);
    expect(() => b.take(2)).toThrow(BudgetExceeded);
    expect(b.remaining()).toBe(1);
    b.take(1);
    expect(b.used()).toBe(3);
    expect(() => b.take(1)).toThrow(/budget of 3/);
  });

  it("Azure is configured only when all four service principal values are set", () => {
    expect(insightsConfigured(makeEnv().env)).toBe(true);
    expect(insightsConfigured(makeEnv(NO_AZURE).env)).toBe(false);
    expect(insightsConfigured(makeEnv({ AZURE_CLIENT_SECRET: "" }).env)).toBe(false);
    expect(insightsConfigured(makeEnv({ AZURE_SUBSCRIPTION_ID: "REPLACE_ME" }).env)).toBe(false);
  });
});

// ── Routes (spec section 8) ─────────────────────────────────────────────────

const ISO = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
const feedShape = (status: string) => ({ id: expect.any(String), title: expect.any(String), status, lastOkAt: null, error: null, cadenceMin: expect.any(Number) });

/** The routes with the query each needs, and the shape it answers before any data exists. */
function routes(status: string, configured: boolean): [string, unknown][] {
  const feed = feedShape(status);
  return [
    [
      "/azure/summary",
      {
        configured,
        region: { id: "uksouth", name: "UK South" },
        feeds: FEEDS.map((f) => ({ ...feed, id: f.id, title: f.title, cadenceMin: f.cadenceMin })),
        health: null,
        maintenance: [],
        serviceIssues: [],
        vitals: null,
        agent: "none",
        latest: { cpuPct: null, creditsLeft: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null },
      },
    ],
    ["/azure/metrics?resource=vm&range=24h", { resource: "vm", range: "24h", step: 300, columns: expect.arrayContaining(["t", "cpu_avg", "credits_min"]), points: [] }],
    ["/azure/metrics?resource=pip&range=1h", { resource: "pip", range: "1h", step: 300, columns: expect.arrayContaining(["t", "ddos_max", "vip_avail"]), points: [] }],
    ["/azure/metrics?resource=vitals&range=7d", { resource: "vitals", range: "7d", step: expect.any(Number), columns: expect.arrayContaining(["t", "mem_used_pct", "net_loss_pct"]), points: [] }],
    ["/azure/changes?range=7d&who=all", { range: "7d", feed: { ...feed, id: "activity", title: FEED_TITLES.activity }, rows: [] }],
    ["/azure/changes", { range: "7d", feed: { ...feed, id: "activity", title: FEED_TITLES.activity }, rows: [] }],
    ["/azure/service-health?range=30d", { events: [], feed: { ...feed, id: "serviceHealth", title: FEED_TITLES.serviceHealth } }],
    [
      "/azure/capacity?region=uksouth&size=Standard_B1s",
      { region: "uksouth", size: "Standard_B1s", available: null, reason: null, vcpusNeeded: null, family: null, total: null, ok: null, message: null, fetchedAt: null },
    ],
    [
      "/azure/price?region=uksouth&size=Standard_B1s",
      { region: "uksouth", size: "Standard_B1s", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: 0.0157, standbyGbpPerHour: 0.0064, fetchedAt: null, stale: false, source: "fixed", reason: expect.any(String) },
    ],
    ["/azure/diagnostics", { configured, feeds: FEEDS.map((f) => ({ ...feed, id: f.id, title: f.title, cadenceMin: f.cadenceMin, lastTryAt: null, nextDueAt: null })), metricNames: { vm: null, pip: null } }],
    ["/azure/bootlog", { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: expect.any(String) }],
  ];
}

describe("/api/v1/azure routes", () => {
  it("every /api/v1/azure route answers its spec 8 shape with configured false and no fetch", async () => {
    const { env } = apiEnv(NO_AZURE);
    const spy = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", spy);
    for (const [path, want] of routes("not_configured", false)) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("Cache-Control"), path).toBe("no-store");
      expect(r.json, path).toEqual(want);
    }
    const post = await api(env, "POST", "/azure/bootlog");
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: "Azure isn't connected. Add the service principal secrets to the Worker." });
    expect(spy).not.toHaveBeenCalled();
  });

  it("with Azure configured but nothing collected yet, every feed is idle and still nothing is fetched", async () => {
    const { env } = apiEnv();
    const spy = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", spy);
    for (const [path, want] of routes("idle", true)) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual(want);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses unknown query keys and values outside the spec's lists, naming the field", async () => {
    const { env } = apiEnv(NO_AZURE);
    const cases: [string, string][] = [
      ["/azure/summary?x=1", "x"],
      ["/azure/metrics?resource=disk&range=24h", "resource"],
      ["/azure/metrics?resource=vm&range=2h", "range"],
      ["/azure/metrics?resource=vm", "range"],
      ["/azure/metrics?resource=vm&range=24h&step=60", "step"],
      ["/azure/changes?range=1h", "range"],
      ["/azure/changes?who=me", "who"],
      ["/azure/service-health?range=24h", "range"],
      ["/azure/capacity?size=Standard_B1s", "region"],
      ["/azure/capacity?region=mars&size=Standard_B1s", "region"],
      ["/azure/capacity?region=uksouth", "size"],
      ["/azure/capacity?region=uksouth&size=Huge'1", "size"],
      ["/azure/price?region=uksouth&size=Standard_B1s&currency=USD", "currency"],
      ["/azure/bootlog?full=1", "full"],
      ["/azure/diagnostics?secrets=1", "secrets"],
    ];
    for (const [path, field] of cases) {
      const r = await api(env, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.json.error, path).toMatchObject({ code: "bad_input", field });
    }
    expect((await api(env, "GET", "/azure/nope")).status).toBe(404);
  });

  it("routes refuse cross-site requests", async () => {
    const { env } = apiEnv(NO_AZURE);
    const r = await api(env, "POST", "/azure/bootlog", undefined, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
    // And every route is behind the login: no bypass, no Access token, no answer.
    const { env: closed } = makeEnv({ ...NO_AZURE, PUBLIC_URL: "http://localhost:8787" });
    for (const path of ["/azure/summary", "/azure/bootlog", "/azure/diagnostics"]) expect((await api(closed, "GET", path)).status, path).toBeGreaterThanOrEqual(401);
  });

  it("settings carry rateSource and price, and overview carries capacity, before the collectors exist", async () => {
    const { env } = apiEnv(NO_AZURE);
    const s = await api(env, "GET", "/settings");
    expect(s.json.rateSource).toBe("fixed");
    expect(s.json.price).toMatchObject({ region: "uksouth", size: "Standard_B1s", source: "fixed", totalGbpPerHour: 0.0157 });
    const o = await api(env, "GET", "/overview");
    expect(o.json.capacity).toBeNull();
  });
});

// ── The dev seeder ──────────────────────────────────────────────────────────

const NOW = "2026-10-02T14:00:00.000Z";

async function seed(env: Env, scenario: string) {
  const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
  const r = await worker.fetch(new Request(`http://localhost:8787/__dev/seed?${new URLSearchParams({ scenario, now: NOW })}`, { method: "POST" }), env, ctx);
  expect(r.status, await r.clone().text()).toBe(200);
}

const rows = async (env: Env, table: string) => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n);

describe("the insights scenario", () => {
  it("devseed wipes the az tables in every scenario and the insights scenario fills them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    expect(SCENARIOS).toContain("insights");
    const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
    await seed(env, "insights");
    for (const t of AZ_TABLES) expect(await rows(env, t), t).toBeGreaterThan(0);
    for (const s of SCENARIOS.filter((x) => x !== "insights")) {
      await seed(env, "insights");
      await seed(env, s);
      for (const t of AZ_TABLES) expect(await rows(env, t), `${s} ${t}`).toBe(0);
      // No other story has vitals: the pixel baseline holds.
      expect(await rows(env, "hist_vm WHERE mem_used_pct IS NOT NULL"), s).toBe(0);
      const snap = await getSnapshot(env);
      expect(snap.agent?.vitals ?? null, s).toBeNull();
    }
  }, 60_000);

  it("insights is running with every feed ok, a credits dip, one outside NSG change, an active regional issue, a scheduled Reboot and an agent with vitals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
    await seed(env, "insights");
    const snap = await getSnapshot(env);
    expect(snap.state).toBe("running");
    expect(snap.agent!.agent_version).toBe(7);
    expect(snap.agent!.vitals!.mem).toEqual({ total: expect.any(Number), available: expect.any(Number) });
    expect(snap.agent!.vitals!.events!.items).toEqual([expect.objectContaining({ type: "Reboot", status: "Scheduled", self: true })]);
    const feeds = (await env.DB.prepare("SELECT feed, status FROM az_feed ORDER BY feed").all<{ feed: string; status: string }>()).results;
    expect(feeds.map((f) => f.feed).sort()).toEqual([...FEED_IDS].sort());
    expect(feeds.every((f) => f.status === "ok")).toBe(true);
    const credits = (await env.DB.prepare("SELECT MIN(credits_min) AS lo, MAX(credits_min) AS hi FROM hist_az_vm").first<{ lo: number; hi: number }>())!;
    expect(credits.lo).toBeLessThan(30);
    expect(credits.hi).toBeGreaterThan(100);
    const outside = (await env.DB.prepare("SELECT caller_kind, resource_type FROM az_activity WHERE caller_kind = 'person'").all()).results;
    expect(outside).toEqual([{ caller_kind: "person", resource_type: "Network security group" }]);
    const issues = (await env.DB.prepare("SELECT type, status, regions FROM az_service_events WHERE status = 'Active'").all<{ type: string; status: string; regions: string }>()).results;
    expect(issues).toEqual([{ type: "ServiceIssue", status: "Active", regions: JSON.stringify(["UK South"]) }]);
    expect(await rows(env, "hist_vm WHERE mem_used_pct IS NOT NULL")).toBeGreaterThan(0);
    // Fixtures stay fake: TEST-NET addresses, example names, no real subscription id.
    const all = JSON.stringify((await env.DB.prepare("SELECT * FROM az_activity").all()).results) + JSON.stringify((await env.DB.prepare("SELECT * FROM az_latest").all()).results);
    expect(all).not.toMatch(/clydeford|@gmail|5bdc4d78/);
  });

  it("insights tells the running story underneath: the same clients, runs and snapshot as running, plus the Azure data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const dump = async (s: string) => {
      const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" });
      await seed(env, s);
      const out: Record<string, unknown> = {};
      for (const t of ["peers", "runs", "alerts", "audit", "cost_days", "hist_client", "hist_drops"]) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results.map((r: any) => ({ ...r, fetched_at: undefined }));
      const snap = await getSnapshot(env);
      return { out, snap: { ...snap, updated_at: undefined, agent: snap.agent ? { ...snap.agent, vitals: undefined, agent_version: undefined } : null } };
    };
    expect(await dump("insights")).toEqual(await dump("running"));
  });
});
