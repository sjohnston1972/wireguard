// insights-servicehealth.test.ts
//
// Plain English: the Service Health feed (plan X1.5): Azure's own service
// issues and planned maintenance, kept only when they touch VMs or
// networking in a region wg-admin uses.
import { describe, it, expect, afterEach, vi } from "vitest";
import { normaliseServiceEvents, activeRegionalIssues, serviceHealthQuery } from "../src/insights/feeds/serviceHealth";
import { runInsights } from "../src/insights/runner";
import { azureEnv, allNotDue, setFeed, feedRows, callsTo, fixture, json, NOW, ago, iso, MIN } from "./insights-helpers";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const stored = async (env: Env) => (await env.DB.prepare("SELECT * FROM az_service_events ORDER BY tracking_id").all<any>()).results;

async function only(env: Env) {
  await env.DB.prepare("DELETE FROM profiles").run(); // the configured region only
  await allNotDue(env);
  await setFeed(env, "serviceHealth", { status: "ok", next_due_at: ago(1) });
}

describe("service health feed", () => {
  it("keeps ServiceIssue and PlannedMaintenance for VM and network services in the configured region", async () => {
    const rows = normaliseServiceEvents(fixture("service-events"), ["UK South"], NOW);
    expect(rows.map((r) => r.tracking_id)).toEqual(["AB1C-2DE", "FG3H-4IJ"]);
    expect(rows[0]).toEqual({
      tracking_id: "AB1C-2DE",
      type: "ServiceIssue",
      status: "Active",
      level: "Error",
      title: "Connectivity issues for Virtual Machines in UK South",
      summary: "Impact Statement: Starting at 09:20 UTC some customers may see packet loss to virtual machines. Engineers are investigating & will update in 60 minutes.",
      services: ["Virtual Machines", "Virtual Network"],
      regions: ["UK South", "UK West"],
      starts_at: "2026-10-04T09:20:00.000Z",
      ends_at: null,
      updated_at: "2026-10-04T09:50:00.000Z",
    });
    expect(rows[1]).toMatchObject({ type: "PlannedMaintenance", status: "Resolved", services: ["Network Infrastructure"], ends_at: "2026-09-30T05:00:00.000Z" });
    // A region in a profile counts too; East US's VM issue is kept when East US is in use.
    expect(normaliseServiceEvents(fixture("service-events"), ["UK South", "East US"], NOW).map((r) => r.tracking_id)).toContain("PQ7R-8ST");

    // Through the runner: the region's plain Azure name comes from REGIONS (uksouth → UK South).
    const { env, az } = azureEnv();
    await only(env);
    await runInsights(env, NOW);
    expect((await stored(env)).map((r: any) => [r.tracking_id, JSON.parse(r.services), JSON.parse(r.regions)])).toEqual([
      ["AB1C-2DE", ["Virtual Machines", "Virtual Network"], ["UK South", "UK West"]],
      ["FG3H-4IJ", ["Network Infrastructure"], ["UK South"]],
    ]);
    const call = callsTo(az, "Microsoft.ResourceHealth/events")[0]!;
    expect(call.u.searchParams.get("api-version")).toBe("2022-10-01");
    expect(call.u.searchParams.get("queryStartTime")).toBe("9/27/2026");
    expect(serviceHealthQuery(NOW)).toBe("api-version=2022-10-01&queryStartTime=9%2F27%2F2026");
  });

  it("serviceIssues lists only active issues", async () => {
    const { env, az } = azureEnv();
    const reply = fixture("service-events");
    // An active planned maintenance in the region: not an issue.
    reply.value.push({ name: "MM1-ACT", properties: { eventType: "PlannedMaintenance", status: "Active", title: "Maintenance now", level: "Informational", lastUpdateTime: "2026-10-04T09:00:00Z", impact: [{ impactedService: "Virtual Machines", impactedRegions: [{ impactedRegion: "UK South" }] }] } });
    az.handlers.push((c) => (c.url.includes("Microsoft.ResourceHealth/events") ? json(reply) : undefined));
    await only(env);
    await runInsights(env, NOW);
    const issues = await activeRegionalIssues(env.DB, "UK South");
    expect(issues.map((e) => e.trackingId)).toEqual(["AB1C-2DE"]);
    expect(issues[0]).toMatchObject({ type: "ServiceIssue", status: "Active", services: ["Virtual Machines", "Virtual Network"], startsAt: "2026-10-04T09:20:00.000Z", endsAt: null });
    expect(await activeRegionalIssues(env.DB, "West Europe")).toEqual([]);
  });

  it("resolved events are kept 90 days", async () => {
    const { env, az } = azureEnv();
    await only(env);
    await runInsights(env, NOW);
    // A later reply (7 days back) no longer lists last week's maintenance: it stays stored.
    az.handlers.push((c) => (c.url.includes("Microsoft.ResourceHealth/events") ? json({ value: [] }) : undefined));
    await setFeed(env, "serviceHealth", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, new Date(NOW.getTime() + 15 * MIN));
    expect((await stored(env)).map((r: any) => r.tracking_id)).toEqual(["AB1C-2DE", "FG3H-4IJ"]);
  });

  it("runs every 15 minutes", async () => {
    const { env, az } = azureEnv();
    await only(env);
    await runInsights(env, NOW);
    expect((await feedRows(env)).serviceHealth).toMatchObject({ status: "ok", next_due_at: iso(NOW.getTime() + 15 * MIN) });
    await runInsights(env, new Date(NOW.getTime() + 10 * MIN));
    expect(callsTo(az, "Microsoft.ResourceHealth/events")).toHaveLength(1);
    await runInsights(env, new Date(NOW.getTime() + 15 * MIN));
    expect(callsTo(az, "Microsoft.ResourceHealth/events")).toHaveLength(2);
  });
});
