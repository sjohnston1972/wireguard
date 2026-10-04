// insights-contract.test.ts
//
// Plain English: the contract the Azure insights areas build on (plan
// 2026-10-04-azure-insights-plan.md, X0.4). The tables exist (migration
// 0019), the second cron reaches the collector and only the collector,
// the /api/v1/azure routes answer their spec section 8 shapes (tested
// unmocked in insights-routes.test.ts), and the dev seeder knows the new tables and the
// `insights` story.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { makeEnv } from "./harness";
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
    // 0019 is followed only by later plans' migrations (0020_labs.sql).
    expect(files.indexOf("0019_azure_insights.sql")).toBe(files.indexOf("0020_labs.sql") - 1);
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

describe("one cron runs both", () => {
  // Live 2026-10-04: Cloudflare registered a second trigger ("2-59/5", then the minutes
  // listed out) but never fired it, while the watchman's "*/5" ran every time. The
  // collector now runs in the watchman's invocation, after the watchman.
  it("wrangler.toml declares only the watchman's cron", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const line = toml.split(/\r?\n/).find((l) => l.startsWith("crons = "));
    expect(line).toBe(`crons = ["${WATCHMAN_CRON}"]`);
    expect(toml).not.toContain(INSIGHTS_CRON);
    expect(WATCHMAN_CRON).toBe("*/5 * * * *");
  });

  const fire = async (env: Env, cron: string) => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnCancel() {} } as unknown as ExecutionContext;
    await worker.scheduled!({ cron, scheduledTime: Date.parse("2026-10-04T10:05:00Z"), type: "scheduled", noRetry() {} } as unknown as ScheduledController, env, ctx);
    await Promise.all(waits);
  };

  it("the watchman's cron runs the watchman, then the collector", async () => {
    const { runInsights } = await import("../src/insights/runner");
    const { runScheduled } = await import("../src/monitor");
    const order: string[] = [];
    vi.mocked(runScheduled).mockImplementation(async () => { order.push("watchman"); return []; });
    vi.mocked(runInsights).mockImplementation(async () => { order.push("insights"); return []; });
    const { env } = makeEnv();
    await fire(env, WATCHMAN_CRON);
    expect(order).toEqual(["watchman", "insights"]);
    expect(vi.mocked(runInsights).mock.calls[0]![1]).toEqual(new Date("2026-10-04T10:05:00Z"));
  });

  it("a failing watchman does not stop the collector, and a failing collector does not touch the watchman", async () => {
    const { runInsights } = await import("../src/insights/runner");
    const { runScheduled } = await import("../src/monitor");
    vi.mocked(runScheduled).mockRejectedValueOnce(new Error("watchman broke"));
    vi.mocked(runInsights).mockResolvedValueOnce([]);
    const { env } = makeEnv();
    await expect(fire(env, WATCHMAN_CRON)).resolves.toBeUndefined();
    expect(runInsights).toHaveBeenCalledTimes(1);
    vi.mocked(runScheduled).mockResolvedValueOnce([]);
    vi.mocked(runInsights).mockRejectedValueOnce(new Error("collector broke"));
    await expect(fire(env, WATCHMAN_CRON)).resolves.toBeUndefined();
    expect(runScheduled).toHaveBeenCalledTimes(2);
  });

  it("a leftover second trigger, if it ever fires, still runs only the collector", async () => {
    const { runInsights } = await import("../src/insights/runner");
    const { runScheduled } = await import("../src/monitor");
    vi.mocked(runInsights).mockResolvedValue([]);
    const { env } = makeEnv();
    await fire(env, INSIGHTS_CRON);
    expect(runInsights).toHaveBeenCalledTimes(1);
    expect(runScheduled).not.toHaveBeenCalled();
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
    // A stored boot log, already redacted the way the collector stores it (no URL, secrets replaced).
    const boot = JSON.parse((await env.DB.prepare("SELECT json FROM az_latest WHERE key = 'bootlog'").first<{ json: string }>())!.json);
    expect(boot).toMatchObject({ fetchedAt: expect.any(String), truncated: false, redactions: 2, reason: null });
    expect(boot.text).toMatch(/Linux version/);
    expect(boot.text.match(/‹redacted›/g)).toHaveLength(2);
    expect(boot.bytes).toBe(new TextEncoder().encode(boot.text).length);
    expect(boot.text).not.toMatch(/https?:\/\//);
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
