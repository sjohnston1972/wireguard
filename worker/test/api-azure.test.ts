// api-azure.test.ts
//
// Plain English: the /api/v1/azure routes filled from what the collector
// stored (plan X1.9), the daily housekeeping, and two whole-run checks with
// every real feed: the worst case stays within 25 outside calls, and a
// failed sign-in still lets the price feed run.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, base } from "./api-helpers";
import { runInsights } from "../src/insights/runner";
import { saveSnapshot } from "../src/state";
import { AZ_RUN_BUDGET, FEED_IDS } from "../src/insights/types";
import { FEEDS, PIP_COLUMNS, VITALS_COLUMNS, VM_COLUMNS } from "../../shared/azureMetrics";
import { azureEnv, running, agentReport, allNotDue, setFeed, feedRows, callsTo, countD1, json, NOW, ago, iso, MIN, CLIENT, SECRET, SUB, FAKE_TOKEN } from "./insights-helpers";
import type { Env } from "../src/env";
import type { VmVitals } from "../src/state";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DAY = 24 * 60 * MIN;

function routeEnv() {
  const made = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  return made;
}

const slot = (ms: number) => new Date(Math.floor(ms / 300_000) * 300_000).toISOString().replace(".000Z", "Z");

async function vmRow(env: Env, t: string, cols: Record<string, number | null>) {
  const keys = Object.keys(cols);
  await env.DB.prepare(`INSERT INTO hist_az_vm (res, t${keys.map((k) => `, ${k}`).join("")}) VALUES (CAST(?1 AS INTEGER), ?2${keys.map((_, i) => `, ?${i + 3}`).join("")})`).bind(300, t, ...keys.map((k) => cols[k])).run();
}
async function pipRow(env: Env, t: string, cols: Record<string, number | null>) {
  const keys = Object.keys(cols);
  await env.DB.prepare(`INSERT INTO hist_az_pip (res, t${keys.map((k) => `, ${k}`).join("")}) VALUES (CAST(?1 AS INTEGER), ?2${keys.map((_, i) => `, ?${i + 3}`).join("")})`).bind(300, t, ...keys.map((k) => cols[k])).run();
}
async function activityRow(env: Env, id: string, at: string, callerKind: string, category = "Administrative", type = "Network security group") {
  await env.DB.prepare("INSERT INTO az_activity (id, at, correlation_id, operation, status, caller, caller_kind, resource_type, resource_name, category, level) VALUES (?1, ?2, ?1, 'Microsoft.Network/networkSecurityGroups/write', 'Succeeded', ?3, ?4, ?5, 'nsg-wg', ?6, 'Informational')")
    .bind(id, at, callerKind === "person" ? "someone@example.net" : callerKind === "wgadmin" ? CLIENT : "Microsoft.Advisor", callerKind, type, category)
    .run();
}

const VITALS: VmVitals = {
  mem: { total: 1_000_000_000, available: 400_000_000 },
  disk: { total: 30_000_000_000, used: 6_000_000_000, avail: 24_000_000_000 },
  cpu: { steal_pct: 1.5, iowait_pct: 0.2, ncpu: 1 },
  conntrack: { count: 61, max: 32768 },
  updates: { pending: 3, security: 1, at: ago(60) },
  events: {
    incarnation: 2,
    at: ago(1),
    items: [
      { id: "ev-later", type: "Redeploy", status: "Scheduled", not_before: iso(NOW.getTime() + 5 * 60 * MIN), source: "Platform", duration_s: null, description: "Later.", self: true },
      { id: "ev-soon", type: "Reboot", status: "Scheduled", not_before: iso(NOW.getTime() + 3 * 60 * MIN), source: "Platform", duration_s: 300, description: "Host server maintenance.", self: true },
      { id: "ev-other", type: "Freeze", status: "Scheduled", not_before: iso(NOW.getTime() + 60 * MIN), source: "Platform", duration_s: 5, description: "Another VM.", self: false },
    ],
  },
  net: { at: ago(3), method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: 9.4, loss_pct: 0 }, { ip: "8.8.8.8", rtt_ms: null, loss_pct: 100 }] },
};

describe("GET /api/v1/azure/summary", () => {
  it("summary: needsDeploy when a running VM's agent is older than 7", async () => {
    const { env } = routeEnv();
    await running(env, { agent: agentReport({ agent_version: 6, vitals: null }) });
    expect((await api(env, "GET", "/azure/summary")).json).toMatchObject({ agent: "needsDeploy", vitals: null });
    await running(env, { agent: agentReport({ agent_version: undefined, vitals: undefined }) });
    expect((await api(env, "GET", "/azure/summary")).json.agent).toBe("needsDeploy");
    await running(env, { agent: agentReport({ agent_version: 7, vitals: VITALS }) });
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.agent).toBe("current");
    expect(s.vitals).toEqual({
      at: ago(0.5),
      memUsedPct: 60,
      diskUsedPct: 20,
      diskFreeBytes: 24_000_000_000,
      load1: 0.12,
      ncpu: 1,
      stealPct: 1.5,
      uptimeS: 7200,
      conntrack: { count: 61, max: 32768 },
      updates: { pending: 3, security: 1, at: ago(60) },
      net: { at: ago(3), method: "icmp", targets: [{ ip: "1.1.1.1", rttMs: 9.4, lossPct: 0 }, { ip: "8.8.8.8", rttMs: null, lossPct: 100 }] },
    });
    // This VM's scheduled events, soonest first.
    expect(s.maintenance).toEqual([
      { id: "ev-soon", type: "Reboot", status: "Scheduled", notBefore: iso(NOW.getTime() + 3 * 60 * MIN), source: "Platform", description: "Host server maintenance.", durationS: 300 },
      { id: "ev-later", type: "Redeploy", status: "Scheduled", notBefore: iso(NOW.getTime() + 5 * 60 * MIN), source: "Platform", description: "Later.", durationS: null },
    ]);
    // Not running: no agent figures.
    await saveSnapshot(env, { state: "destroyed", since: ago(1) });
    expect((await api(env, "GET", "/azure/summary")).json).toMatchObject({ agent: "none", vitals: null, maintenance: [], health: null });
  });

  it("summary latest values come from the newest slot", async () => {
    const { env } = routeEnv();
    await running(env);
    const t = (minAgo: number) => slot(NOW.getTime() - minAgo * MIN);
    await vmRow(env, t(15), { cpu_avg: 50, credits_min: 10, mem_free_min: 1 });
    await vmRow(env, t(10), { cpu_avg: 40, credits_min: 20, mem_free_min: 2 });
    await vmRow(env, t(5), { cpu_avg: 7.75, credits_min: null, mem_free_min: 413_000_000 });
    await pipRow(env, t(10), { vip_avail: 100, ddos_max: 0 });
    await pipRow(env, t(5), { vip_avail: 99.2, ddos_max: 1 });
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.latest).toEqual({ cpuPct: 7.75, creditsLeft: null, creditsTrend: null, memFreeBytes: 413_000_000, vipAvailPct: 99.2, underDdos: true, at: t(5) });
    // Hours-old slots are not "latest".
    await env.DB.prepare("UPDATE hist_az_vm SET t = '2026-10-03T00:00:00Z' WHERE t = ?1").bind(t(5)).run();
    await env.DB.prepare("DELETE FROM hist_az_vm WHERE t <> '2026-10-03T00:00:00Z'").run();
    await env.DB.prepare("DELETE FROM hist_az_pip").run();
    expect((await api(env, "GET", "/azure/summary")).json.latest).toEqual({ cpuPct: null, creditsLeft: null, creditsTrend: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null });
  });

  // Live test 2026-10-04: the verdict warned about a fresh VM's launch credits. It now
  // needs to know whether the credits are being spent down, from the last hour of slots.
  it("summary says whether CPU credits are falling, flat or rising over the last hour", async () => {
    const { env } = routeEnv();
    await running(env);
    const t = (minAgo: number) => slot(NOW.getTime() - minAgo * MIN);
    const trend = async () => (await api(env, "GET", "/azure/summary")).json.latest.creditsTrend;
    // One reading (a fresh VM's first slot): no trend yet.
    await vmRow(env, t(5), { credits_min: 28.9 });
    expect(await trend()).toBeNull();
    // A fresh VM earning credits while idle.
    await vmRow(env, t(20), { credits_min: 27.6 });
    expect(await trend()).toBe("rising");
    // Spent down over the hour (the reading from 70 minutes ago is out of the window).
    await env.DB.prepare("DELETE FROM hist_az_vm").run();
    await vmRow(env, t(70), { credits_min: 10 });
    await vmRow(env, t(55), { credits_min: 60 });
    await vmRow(env, t(30), { credits_min: 45 });
    await vmRow(env, t(5), { credits_min: 28.9 });
    expect(await trend()).toBe("falling");
    // Held where it is.
    await env.DB.prepare("UPDATE hist_az_vm SET credits_min = 29.2 WHERE t = ?1").bind(t(55)).run();
    expect(await trend()).toBe("flat");
  });

  it("summary carries health with annotations, the region's active issues and each feed's status", async () => {
    const { env } = routeEnv();
    await running(env);
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('health', ?1, ?2)").bind(JSON.stringify({ state: "Degraded", title: "Degraded", summary: "Host fault.", reason: "Unplanned", since: ago(30), power: "VM running", provisioning: "Provisioning succeeded", vmAgent: { status: "Ready", version: "2.11" }, bootDiagnostics: true, checkedAt: ago(2) }), ago(2)).run();
    await env.DB.prepare("INSERT INTO az_activity (id, at, correlation_id, operation, status, caller, caller_kind, resource_type, resource_name, category, level) VALUES ('rh1', ?1, 'c', 'Microsoft.Resourcehealth/healthevent/Activated/action', 'Active', NULL, 'azure', 'Virtual machine', 'vm-wg', 'ResourceHealth', 'Warning')").bind(ago(40)).run();
    await env.DB.prepare("INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('I1', 'ServiceIssue', 'Active', 'Warning', 'VM trouble', 's', '[\"Virtual Machines\"]', '[\"UK South\"]', ?1, NULL, ?1)").bind(ago(20)).run();
    await env.DB.prepare("INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('M1', 'PlannedMaintenance', 'Active', 'Informational', 'Maint', 's', '[\"Virtual Machines\"]', '[\"UK South\"]', ?1, NULL, ?1)").bind(ago(20)).run();
    await setFeed(env, "health", { status: "ok", last_ok_at: ago(2), last_try_at: ago(2) });
    await setFeed(env, "vmMetrics", { status: "error", last_ok_at: ago(30), last_try_at: ago(2), error: "Azure refused the VM metrics (500)." });
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.configured).toBe(true);
    expect(s.region).toEqual({ id: "uksouth", name: "UK South" });
    expect(s.health).toMatchObject({ state: "Degraded", annotations: [{ at: ago(40), title: "Azure reported a problem with the VM" }] });
    expect(s.serviceIssues.map((e: any) => e.trackingId)).toEqual(["I1"]);
    const feed = (id: string) => s.feeds.find((f: any) => f.id === id);
    expect(s.feeds.map((f: any) => f.id)).toEqual(FEEDS.map((f) => f.id));
    expect(feed("health")).toEqual({ id: "health", title: "Azure health", status: "ok", lastOkAt: ago(2), error: null, cadenceMin: 5 });
    expect(feed("vmMetrics")).toMatchObject({ status: "error", error: "Azure refused the VM metrics (500).", lastOkAt: ago(30) });
    expect(feed("prices").status).toBe("idle");
    expect(feed("activity").cadenceMin).toBe(5); // running: every 5 minutes
  });
});

describe("other routes", () => {
  it("metrics ranges and vitals columns", async () => {
    const { env } = routeEnv();
    const now = NOW.getTime();
    for (let m = 5; m <= 120; m += 5) await vmRow(env, slot(now - m * MIN), { cpu_avg: m, cpu_max: m * 2, credits_min: 200 - m, net_in: 1000 });
    for (let m = 5; m <= 30; m += 5) await pipRow(env, slot(now - m * MIN), { packets: 100, pkts_drop_ddos: m });
    await vmRow(env, slot(now - 40 * DAY), { cpu_avg: 99 });

    let r = await api(env, "GET", "/azure/metrics?resource=vm&range=1h");
    expect(r.json).toMatchObject({ resource: "vm", range: "1h", step: 300, columns: ["t", ...VM_COLUMNS] });
    expect(r.json.points).toHaveLength(12); // 5..60 minutes ago
    expect(r.json.points.at(-1)).toMatchObject({ t: slot(now - 5 * MIN), cpu_avg: 5, cpu_max: 10, credits_min: 195, mem_free_min: null });

    r = await api(env, "GET", "/azure/metrics?resource=vm&range=7d");
    expect(r.json.step).toBe(1800);
    const half = r.json.points.find((p: any) => p.t === "2026-10-04T09:30:00Z");
    // 09:30–09:55 holds the rows from 10 to 35 minutes ago: averages average, peaks take the max, minimums the min, rates stay rates.
    const ms = [10, 15, 20, 25, 30, 35];
    expect(half).toMatchObject({ cpu_max: Math.max(...ms.map((m) => m * 2)), credits_min: 200 - 35, net_in: 1000 });
    expect(half.cpu_avg).toBeCloseTo(ms.reduce((a, b) => a + b, 0) / 6, 6);
    expect(r.json.points.some((p: any) => p.cpu_avg === 99)).toBe(false); // older than the range

    r = await api(env, "GET", "/azure/metrics?resource=pip&range=24h");
    expect(r.json).toMatchObject({ resource: "pip", step: 300, columns: ["t", ...PIP_COLUMNS] });
    expect(r.json.points).toHaveLength(6);
    expect(r.json.points[0]).toMatchObject({ packets: 100, ddos_max: null });

    // Vitals: the new hist_vm columns, the heartbeat's own steps; steal and loss keep their peaks.
    const put = (t: string, mem: number, steal: number, loss: number) => env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received, mem_used_pct, disk_used_pct, steal_pct, conntrack_pct, net_rtt_ms, net_loss_pct) VALUES (60, ?1, 1, 1, ?2, 20, ?3, 0.2, 10, ?4)").bind(t, mem, steal, loss).run();
    await put("2026-10-04T10:00:00Z", 40, 1, 0);
    await put("2026-10-04T10:01:00Z", 50, 9, 50);
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, '2026-10-04T10:02:00Z', 1, 1)").run(); // an old agent's minute: no vitals
    r = await api(env, "GET", "/azure/metrics?resource=vitals&range=24h");
    expect(r.json).toMatchObject({ resource: "vitals", step: 300, columns: ["t", ...VITALS_COLUMNS] });
    expect(r.json.points).toEqual([{ t: "2026-10-04T10:00:00Z", mem_used_pct: 45, disk_used_pct: 20, steal_pct: 9, conntrack_pct: 0.2, net_rtt_ms: 10, net_loss_pct: 50 }]);
    r = await api(env, "GET", "/azure/metrics?resource=vitals&range=1h");
    expect(r.json.step).toBe(60);
    expect(r.json.points).toHaveLength(2);
  });

  it("changes who filter", async () => {
    const { env } = routeEnv();
    await activityRow(env, "a1", ago(60), "person");
    await activityRow(env, "a2", ago(50), "wgadmin");
    await activityRow(env, "a3", ago(40), "azure");
    await activityRow(env, "a4", ago(30), "azure", "ResourceHealth", "Virtual machine"); // an annotation, not a change
    await activityRow(env, "a5", ago(10 * 24 * 60), "person");
    let r = await api(env, "GET", "/azure/changes");
    expect(r.json.range).toBe("7d");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["a3", "a2", "a1"]);
    expect(r.json.rows[2]).toEqual({ id: "a1", at: ago(60), operation: "Microsoft.Network/networkSecurityGroups/write", status: "Succeeded", caller: "someone@example.net", callerKind: "person", resourceType: "Network security group", resourceName: "nsg-wg" });
    r = await api(env, "GET", "/azure/changes?who=others&range=30d");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["a3", "a1", "a5"]);
    r = await api(env, "GET", "/azure/changes?who=wgadmin");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["a2"]);
    r = await api(env, "GET", "/azure/changes?range=24h&who=all");
    expect(r.json.rows).toHaveLength(3);
    expect(r.json.feed).toMatchObject({ id: "activity", status: "idle" });
  });

  it("service-health range", async () => {
    const { env } = routeEnv();
    const ev = (id: string, status: string, updatedDaysAgo: number, region = "UK South") =>
      env.DB.prepare("INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES (?1, 'ServiceIssue', ?2, 'Warning', ?1, NULL, '[\"Virtual Machines\"]', ?3, NULL, NULL, ?4)").bind(id, status, JSON.stringify([region]), ago(updatedDaysAgo * 24 * 60)).run();
    await ev("old-resolved", "Resolved", 20);
    await ev("recent-resolved", "Resolved", 2);
    await ev("active-long", "Active", 40);
    await ev("elsewhere", "Active", 1, "East US");
    let r = await api(env, "GET", "/azure/service-health");
    expect(r.json.events.map((e: any) => e.trackingId)).toEqual(["active-long", "recent-resolved", "old-resolved"]);
    r = await api(env, "GET", "/azure/service-health?range=7d");
    expect(r.json.events.map((e: any) => e.trackingId)).toEqual(["active-long", "recent-resolved"]);
    expect(r.json.feed).toMatchObject({ id: "serviceHealth" });
  });

  it("GET /api/v1/azure/diagnostics lists feed status, emitted metric names and last errors without secrets", async () => {
    const { env } = routeEnv();
    await env.STATUS.put("azure:token", JSON.stringify({ token: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 }));
    await setFeed(env, "vmMetrics", { status: "error", last_try_at: ago(2), last_ok_at: ago(60), next_due_at: ago(-3), error: "Azure refused a metric name for this resource (400); the metric names are being read again." });
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('metricDefs', ?1, ?2)").bind(JSON.stringify({ vm: ["Percentage CPU"], pip: null }), ago(60)).run();
    const r = await api(env, "GET", "/azure/diagnostics");
    expect(r.json.configured).toBe(true);
    expect(r.json.metricNames).toEqual({ vm: ["Percentage CPU"], pip: null });
    expect(r.json.feeds.find((f: any) => f.id === "vmMetrics")).toEqual({ id: "vmMetrics", title: "VM metrics", status: "error", lastOkAt: ago(60), error: expect.stringMatching(/metric name/), cadenceMin: 5, lastTryAt: ago(2), nextDueAt: ago(-3) });
    expect(r.json.feeds.find((f: any) => f.id === "health")).toMatchObject({ status: "idle", lastTryAt: null, nextDueAt: null });
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(SUB);
    expect(r.text).not.toContain(CLIENT);
    expect(r.text).not.toContain(FAKE_TOKEN.split(".")[1]!);
  });
});

describe("housekeeping", () => {
  it("housekeeping prunes per spec 6", async () => {
    const { env } = azureEnv();
    const now = NOW.getTime();
    await saveSnapshot(env, { state: "destroyed", since: iso(now - 8 * DAY) });
    await vmRow(env, slot(now - 31 * DAY), { cpu_avg: 1 });
    await vmRow(env, slot(now - 29 * DAY), { cpu_avg: 2 });
    await pipRow(env, slot(now - 31 * DAY), { packets: 1 });
    await pipRow(env, slot(now - 1 * DAY), { packets: 2 });
    await activityRow(env, "old", iso(now - 91 * DAY), "person");
    await activityRow(env, "kept", iso(now - 89 * DAY), "person");
    const ev = (id: string, days: number) => env.DB.prepare("INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES (?1, 'ServiceIssue', 'Resolved', NULL, ?1, NULL, '[]', '[]', NULL, NULL, ?2)").bind(id, iso(now - days * DAY)).run();
    await ev("ev-old", 91);
    await ev("ev-kept", 80);
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('bootlog', '{}', ?1), ('capacity-try:uksouth', '{}', ?2), ('health', '{}', ?1)").bind(iso(now - 8 * DAY), iso(now - 2 * DAY)).run();
    await env.DB.prepare("INSERT INTO az_capacity (region, json, fetched_at) VALUES ('ukwest', '{}', ?1), ('uksouth', '{}', ?2)").bind(iso(now - 31 * DAY), iso(now - 1 * DAY)).run();
    await env.DB.prepare("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES ('ukwest', 'ip:v4', 1, '1 Hour', 'm', ?1), ('uksouth', 'ip:v4', 1, '1 Hour', 'm', ?2)").bind(iso(now - 31 * DAY), iso(now - 8 * DAY)).run();
    await allNotDue(env);
    await setFeed(env, "housekeeping", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    const col = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results.map((r) => Object.values(r)[0]);
    expect(await col("SELECT cpu_avg FROM hist_az_vm")).toEqual([2]);
    expect(await col("SELECT packets FROM hist_az_pip")).toEqual([2]);
    expect(await col("SELECT id FROM az_activity")).toEqual(["kept"]);
    expect(await col("SELECT tracking_id FROM az_service_events")).toEqual(["ev-kept"]);
    // The boot log goes 7 days after the tear-down; old claim markers go; other documents stay.
    expect(await col("SELECT key FROM az_latest ORDER BY key")).toEqual(["health"]);
    expect(await col("SELECT region FROM az_capacity")).toEqual(["uksouth"]);
    expect(await col("SELECT region FROM az_prices")).toEqual(["uksouth"]); // a stale price stays (it says why the fixed rates apply)
    const rows = await feedRows(env);
    expect(rows.housekeeping).toMatchObject({ status: "ok", next_due_at: iso(now + DAY) });
    // Not 7 days yet: the boot log stays.
    await saveSnapshot(env, { state: "destroyed", since: iso(now - 2 * DAY) });
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('bootlog', '{}', ?1)").bind(iso(now - 2 * DAY)).run();
    await setFeed(env, "housekeeping", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    expect(await col("SELECT key FROM az_latest ORDER BY key")).toEqual(["bootlog", "health"]);
  });
});

describe("whole runs with the real feeds", () => {
  it("worst-case run makes at most 25 fetches", async () => {
    const { env, az } = azureEnv({ TEST_VM: "1" });
    // Running with a silent heartbeat (the boot log is due), nothing collected yet, a second region in a profile.
    await running(env, { last_agent_at: ago(10) });
    await env.STATUS.put("flag:unreachable", "1");
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("INSERT INTO profiles (name, region, vm_size) VALUES ('US', 'eastus', 'Standard_B2s')").run();
    await runInsights(env, NOW);
    expect(az.calls.length).toBeLessThanOrEqual(AZ_RUN_BUDGET);
    // sign-in, health, vm, pip, defs, activity (a first run backfills: its 2 pages and the empty third), service health, capacity, prices, boot log
    expect(az.calls.length).toBe(1 + 2 + 1 + 1 + 2 + 3 + 1 + 2 + 1 + 3);
    const rows = await feedRows(env);
    for (const id of FEED_IDS) expect(rows[id]?.status, id).toBe("ok");
    expect(rows.housekeeping.status).toBe("ok");
  });

  it("worst-case run stays within 70 D1 statements in 31 round trips (az_feed read once, results written in one batch)", async () => {
    const { env } = azureEnv({ TEST_VM: "1" });
    // The same worst case as above: every feed due and running.
    await running(env, { last_agent_at: ago(10) });
    await env.STATUS.put("flag:unreachable", "1");
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("INSERT INTO profiles (name, region, vm_size) VALUES ('US', 'eastus', 'Standard_B2s')").run();
    const d1 = countD1(env);
    await runInsights(env, NOW);
    d1.stop();
    const rows = await feedRows(env);
    for (const id of FEED_IDS) expect(rows[id]?.status, id).toBe("ok");
    // az_feed: one read for the whole run, one batch for every feed's result.
    expect(d1.sql.filter((s) => /^SELECT .* FROM az_feed$/.test(s))).toHaveLength(1);
    expect(d1.sql.filter((s) => /^INSERT INTO az_feed/.test(s))).toHaveLength(FEED_IDS.length + 1);
    // The bound for a worst-case run, as measured: 70 statements in 31 round trips (80 in 50 when each
    // feed read all of az_feed and wrote its own row). Most of the rest are the feeds' own stores.
    expect(d1.statements).toBeLessThanOrEqual(70);
    expect(d1.roundTrips).toBeLessThanOrEqual(31);
  });

  it("a feed that fails still has its status recorded in the run's one batch", async () => {
    const { env, az } = azureEnv();
    await running(env);
    az.handlers.push((c) => (c.url.includes("instanceView") ? json({ error: { code: "InternalServerError" } }, 500) : undefined));
    const d1 = countD1(env);
    await runInsights(env, NOW);
    d1.stop();
    const rows = await feedRows(env);
    expect(rows.health.status).toBe("error");
    expect(rows.vmMetrics.status).toBe("ok");
    expect(d1.batchesWith(/^INSERT INTO az_feed/)).toBe(1);
  });

  it("sign-in failure marks ARM feeds error and still runs prices", async () => {
    const { env, az } = azureEnv();
    az.loginStatus = 401;
    await running(env, { last_agent_at: ago(10) });
    await runInsights(env, NOW);
    const rows = await feedRows(env);
    for (const id of ["health", "vmMetrics", "pipMetrics", "metricDefs", "activity", "serviceHealth", "capacity", "bootLog"]) {
      expect(rows[id]?.status, id).toBe("error");
      expect(rows[id]?.error, id).toMatch(/sign-in failed/i);
    }
    expect(rows.prices.status).toBe("ok");
    expect(rows.housekeeping.status).toBe("ok");
    expect(callsTo(az, "login.microsoftonline.com")).toHaveLength(1);
    expect(callsTo(az, "management.azure.com")).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});
