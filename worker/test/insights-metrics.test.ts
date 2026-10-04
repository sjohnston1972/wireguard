// insights-metrics.test.ts
//
// Plain English: the metric feeds (plan X1.3). Azure Monitor's platform
// metrics for the VM and its public IP, one wide row per 5-minute slot, the
// last three complete slots upserted each run; the metric names asked for
// are limited to the ones Azure says each resource emits.
import { describe, it, expect, afterEach, vi } from "vitest";
import { normaliseMetrics, metricsQuery } from "../src/insights/feeds/metrics";
import { runInsights } from "../src/insights/runner";
import { saveSnapshot } from "../src/state";
import { azureMetricNames } from "../../shared/azureMetrics";
import { azureEnv, running, allNotDue, setFeed, feedRows, latest, callsTo, fixture, json, NOW, ago, MIN } from "./insights-helpers";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const rows = async (env: Env, table: string) => (await env.DB.prepare(`SELECT *, typeof(res) AS res_type FROM ${table} ORDER BY t`).all<any>()).results;

async function only(env: Env, feed: string) {
  await allNotDue(env);
  await setFeed(env, feed, { status: "ok", next_due_at: ago(1) });
}

describe("metric feeds", () => {
  it("vm metrics normalise into one wide row per 5-minute slot", () => {
    const out = normaliseMetrics("vm", fixture("metrics-vm"), NOW);
    expect(out.map((r) => r.t)).toEqual(["2026-10-04T09:50:00Z", "2026-10-04T09:55:00Z", "2026-10-04T10:00:00Z"]);
    expect(out[2]).toEqual({
      t: "2026-10-04T10:00:00Z",
      cpu_avg: 7.75,
      cpu_max: 21.5,
      mem_free_min: 413000000,
      net_in: 5000,
      net_out: null,
      disk_read: null,
      disk_write: null, // Azure left the value out: no data, never 0
      disk_rops: null,
      disk_wops: null,
      credits_min: 136.5,
      credits_used: null,
      avail_avg: null,
      os_iops_max: null,
      os_bw_max: null,
    });
  });

  it("byte totals become per-second rates", () => {
    const out = normaliseMetrics("vm", fixture("metrics-vm"), NOW);
    const at = (t: string) => out.find((r) => r.t === t)!;
    expect(at("2026-10-04T09:55:00Z").net_in).toBe(6_000_000 / 300);
    expect(at("2026-10-04T09:55:00Z").disk_write).toBe(90_000 / 300);
    // Not byte totals: as Azure gives them.
    expect(at("2026-10-04T09:55:00Z").cpu_avg).toBe(6.5);
    expect(at("2026-10-04T09:55:00Z").credits_min).toBe(137);
  });

  it("the last three complete slots are upserted (3 rows)", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env, "vmMetrics");
    await runInsights(env, NOW);
    let stored = await rows(env, "hist_az_vm");
    expect(stored.map((r) => r.t)).toEqual(["2026-10-04T09:50:00Z", "2026-10-04T09:55:00Z", "2026-10-04T10:00:00Z"]);
    expect(stored.every((r) => r.res === 300 && r.res_type === "integer")).toBe(true);
    expect(stored[2].disk_write).toBeNull();
    // The timespan is the last 20 minutes up to the current slot, in 5-minute slots.
    const call = callsTo(az, "/providers/Microsoft.Insights/metrics")[0]!;
    expect(call.u.searchParams.get("timespan")).toBe("2026-10-04T09:45:00Z/2026-10-04T10:05:00Z");
    expect(call.u.searchParams.get("interval")).toBe("PT5M");
    expect(call.u.searchParams.get("aggregation")).toBe("Average,Maximum,Minimum,Total");
    expect(call.u.searchParams.get("api-version")).toBe("2023-10-01");

    // Five minutes later the late value arrives; a value Azure leaves out never wipes one stored.
    const later = fixture("metrics-vm");
    const dw = later.value.find((m: any) => m.name.value === "Disk Write Bytes");
    dw.timeseries[0].data = [{ timeStamp: "2026-10-04T10:00:00Z", total: 150000 }, { timeStamp: "2026-10-04T10:05:00Z", total: 3000 }];
    const cpu = later.value.find((m: any) => m.name.value === "Percentage CPU");
    cpu.timeseries[0].data = cpu.timeseries[0].data.map((d: any) => (d.timeStamp === "2026-10-04T10:00:00Z" ? { timeStamp: d.timeStamp } : d)).concat([{ timeStamp: "2026-10-04T10:05:00Z", average: 9, maximum: 10 }]);
    az.handlers.push((c) => (c.url.includes("/Microsoft.Insights/metrics?") ? json(later) : undefined));
    await setFeed(env, "vmMetrics", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    stored = await rows(env, "hist_az_vm");
    expect(stored.map((r) => r.t)).toEqual(["2026-10-04T09:50:00Z", "2026-10-04T09:55:00Z", "2026-10-04T10:00:00Z", "2026-10-04T10:05:00Z"]);
    const ten = stored.find((r) => r.t === "2026-10-04T10:00:00Z");
    expect(ten.disk_write).toBe(500);
    expect(ten.cpu_avg).toBe(7.75);
  });

  it("pip metrics normalise", async () => {
    const out = normaliseMetrics("pip", fixture("metrics-pip"), NOW);
    expect(out.at(-1)).toEqual({ t: "2026-10-04T10:00:00Z", ddos_max: 1, pkts_in_ddos: null, pkts_drop_ddos: 5200, bytes_in_ddos: null, bytes_drop_ddos: null, packets: 98000, bytes: null, syn: null, vip_avail: 99.2 });
    const { env } = azureEnv();
    await running(env);
    await only(env, "pipMetrics");
    await runInsights(env, NOW);
    expect((await rows(env, "hist_az_pip")).map((r) => [r.t, r.packets])).toEqual([["2026-10-04T09:50:00Z", 12000], ["2026-10-04T09:55:00Z", 12600], ["2026-10-04T10:00:00Z", 98000]]);
    // Values that are not numbers are dropped, never stored as 0.
    const odd = fixture("metrics-pip");
    odd.value[2].timeseries[0].data[2].total = "lots";
    expect(normaliseMetrics("pip", odd, NOW).at(-1)!.packets).toBeNull();
    expect(normaliseMetrics("pip", { value: "nope" }, NOW)).toEqual([]);
  });

  it("metricDefs limits metricnames to what the resource emits", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env, "metricDefs");
    await runInsights(env, NOW);
    const defs = await latest(env, "metricDefs");
    expect(defs.vm).toContain("Percentage CPU");
    expect(defs.vm).toContain("Inbound Flows");
    expect(defs.vm).not.toContain("VmAvailabilityMetric");
    expect(defs.pip).toHaveLength(9);
    expect(callsTo(az, "metricDefinitions").map((c) => c.u.searchParams.get("api-version"))).toEqual(["2023-10-01", "2023-10-01"]);

    await setFeed(env, "vmMetrics", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    const asked = callsTo(az, "/providers/Microsoft.Insights/metrics?")[0]!.u.searchParams.get("metricnames")!.split(",");
    expect(asked).toContain("Percentage CPU");
    expect(asked).toContain("Disk Read Operations/Sec");
    expect(asked).not.toContain("VmAvailabilityMetric");
    expect(asked).not.toContain("Inbound Flows"); // emitted, but not in the catalogue
    expect(asked.length).toBe(12);
    // Before metricDefs has run, the whole catalogue is asked for.
    const q = metricsQuery(azureMetricNames("vm"), NOW);
    expect(new URLSearchParams(q).get("metricnames")!.split(",")).toHaveLength(13);
    expect(q).toContain("metricnames=Percentage%20CPU,");
    expect(q).toContain("Disk%20Read%20Operations%2FSec");
    expect(q).not.toMatch(/\+/);
  });

  it("metricDefs is due again after each deploy", async () => {
    const { env, az } = azureEnv();
    await running(env, { running_since: ago(30) });
    await allNotDue(env);
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('metricDefs', ?1, ?2)").bind(JSON.stringify({ vm: ["Percentage CPU"], pip: ["PacketCount"] }), ago(60)).run();
    await runInsights(env, NOW);
    expect(callsTo(az, "metricDefinitions").length).toBe(2);
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    expect(callsTo(az, "metricDefinitions").length).toBe(2);
  });

  it("a 400 for an unknown metric marks metricDefs due and records the error", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env, "vmMetrics");
    await env.DB.prepare("UPDATE az_feed SET next_due_at = ?1 WHERE feed = 'metricDefs'").bind(new Date(NOW.getTime() + 600 * MIN).toISOString()).run();
    az.handlers.push((c) => (c.url.includes("/Microsoft.Insights/metrics?") ? json({ code: "BadRequest", message: "Failed to find metric configuration for provider: Microsoft.Compute, resource Type: virtualMachines, metric: VmAvailabilityMetric" }, 400) : undefined));
    await runInsights(env, NOW);
    const r = await feedRows(env);
    expect(r.vmMetrics.status).toBe("error");
    expect(r.vmMetrics.error).toMatch(/metric name/i);
    // metricDefs ran in the same run, straight after.
    expect(callsTo(az, "metricDefinitions").length).toBe(2);
    expect(r.metricDefs.status).toBe("ok");
  });

  it("vmMetrics runs while running and for 15 minutes after", async () => {
    const { env, az } = azureEnv();
    const count = () => callsTo(az, "virtualMachines/vm-wg/providers/Microsoft.Insights/metrics?").length;
    await saveSnapshot(env, { state: "standby", since: ago(5) });
    await only(env, "vmMetrics");
    await runInsights(env, NOW);
    expect(count()).toBe(1);
    await saveSnapshot(env, { state: "standby", since: ago(20) });
    await only(env, "vmMetrics");
    await runInsights(env, NOW);
    expect(count()).toBe(1);
    await saveSnapshot(env, { state: "destroyed", since: ago(5) });
    await only(env, "vmMetrics");
    await runInsights(env, NOW);
    expect(count()).toBe(1);
  });

  it("a resource already gone (404) stores nothing and is not an error", async () => {
    const { env, az } = azureEnv();
    await saveSnapshot(env, { state: "destroying", since: ago(5) });
    az.handlers.push((c) => (c.url.includes("/Microsoft.Insights/metrics?") ? json({ error: { code: "ResourceNotFound" } }, 404) : undefined));
    await only(env, "vmMetrics");
    await runInsights(env, NOW);
    expect((await feedRows(env)).vmMetrics.status).toBe("ok");
    expect(await rows(env, "hist_az_vm")).toEqual([]);
  });

  it("pipMetrics runs while the IP exists", async () => {
    const { env, az } = azureEnv();
    const count = () => callsTo(az, "publicIPAddresses/pip-wg/providers/Microsoft.Insights/metrics?").length;
    await saveSnapshot(env, { state: "standby", since: ago(300) });
    await only(env, "pipMetrics");
    await runInsights(env, NOW);
    expect(count()).toBe(1);
    await saveSnapshot(env, { state: "destroyed", since: ago(5) });
    await only(env, "pipMetrics");
    await runInsights(env, NOW);
    expect(count()).toBe(1);
  });
});
