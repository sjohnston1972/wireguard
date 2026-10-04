// insights-activity.test.ts
//
// Plain English: the Activity Log feed (plan X1.4): who changed what in the
// resource group, one row per operation, the final status kept; Azure's own
// health notes become annotations; a change made outside wg-admin to the
// VM, NSG, public IP or NIC writes one watchman note.
import { describe, it, expect, afterEach, vi } from "vitest";
import { normaliseActivity, activityCadence, healthAnnotations, callerKind, activityQuery } from "../src/insights/feeds/activity";
import { runInsights } from "../src/insights/runner";
import { saveSnapshot } from "../src/state";
import { azureEnv, running, allNotDue, setFeed, feedRows, callsTo, fixture, json, NOW, ago, iso, MIN, CLIENT, OID } from "./insights-helpers";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const IDS = [CLIENT, OID];
const events = () => [...fixture("activity").value, ...fixture("activity-page2").value];
const stored = async (env: Env) => (await env.DB.prepare("SELECT * FROM az_activity ORDER BY at").all<any>()).results;
const notes = async (env: Env) => (await env.DB.prepare("SELECT kind, message FROM alerts WHERE message LIKE 'Changed in Azure outside wg-admin%' ORDER BY id").all<{ kind: string; message: string }>()).results;

async function only(env: Env) {
  await allNotDue(env);
  await setFeed(env, "activity", { status: "ok", next_due_at: ago(1), last_ok_at: ago(5) });
}

describe("activity feed", () => {
  it("groups by correlationId and keeps the final status", () => {
    const rows = normaliseActivity(events(), IDS);
    const nsg = rows.filter((r) => r.correlation_id === "aaaaaaaa-0000-0000-0000-000000000001");
    expect(nsg).toEqual([expect.objectContaining({ id: "e0000000-0000-0000-0000-000000000002", status: "Succeeded", at: "2026-10-04T09:58:30.123Z" })]);
    // Failed beats Accepted, whichever comes first in the reply.
    const vm = rows.find((r) => r.correlation_id === "aaaaaaaa-0000-0000-0000-000000000002")!;
    expect(vm).toMatchObject({ status: "Failed", level: "Error", operation: "Microsoft.Compute/virtualMachines/write" });
    expect(rows).toHaveLength(6);
  });

  it("caller kinds wgadmin, person, azure", () => {
    expect(callerKind(CLIENT, IDS)).toBe("wgadmin");
    expect(callerKind(CLIENT.toUpperCase(), IDS)).toBe("wgadmin");
    expect(callerKind(OID, IDS)).toBe("wgadmin"); // the service principal's object id, from the token
    expect(callerKind("someone@example.net", IDS)).toBe("person");
    expect(callerKind("Microsoft.Advisor", IDS)).toBe("azure");
    expect(callerKind(null, IDS)).toBe("azure");
    const rows = normaliseActivity(events(), IDS);
    const kind = (c: string) => rows.find((r) => r.correlation_id === c)!.caller_kind;
    expect(kind("aaaaaaaa-0000-0000-0000-000000000001")).toBe("person");
    expect(kind("aaaaaaaa-0000-0000-0000-000000000003")).toBe("wgadmin");
    expect(kind("aaaaaaaa-0000-0000-0000-000000000005")).toBe("azure");
  });

  it("resource types get plain names", () => {
    const rows = normaliseActivity(events(), IDS);
    const of = (c: string) => rows.find((r) => r.correlation_id === c)!;
    expect(of("aaaaaaaa-0000-0000-0000-000000000001")).toMatchObject({ resource_type: "Network security group", resource_name: "nsg-wg" });
    expect(of("aaaaaaaa-0000-0000-0000-000000000002")).toMatchObject({ resource_type: "Virtual machine", resource_name: "vm-wg" });
    expect(of("aaaaaaaa-0000-0000-0000-000000000004")).toMatchObject({ resource_type: "Resource group", resource_name: "rg-wg-ondemand" });
    expect(of("aaaaaaaa-0000-0000-0000-000000000006")).toMatchObject({ resource_type: "Disk", resource_name: "osdisk-wg" });
    const odd = normaliseActivity([{ eventDataId: "x1", correlationId: "c1", eventTimestamp: "2026-10-04T09:00:00Z", operationName: { value: "Microsoft.Storage/storageAccounts/write" }, status: { value: "Succeeded" }, resourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1" }], IDS);
    expect(odd[0]).toMatchObject({ resource_type: "Other", resource_name: "st1", caller: null, caller_kind: "azure" });
    // Junk is dropped, not stored.
    expect(normaliseActivity([null, 3, { eventDataId: "y" }], IDS)).toEqual([]);
  });

  it("ResourceHealth rows become health annotations", async () => {
    const { env } = azureEnv();
    await running(env);
    await only(env);
    await runInsights(env, NOW);
    const notesOnVm = await healthAnnotations(env.DB, 5);
    expect(notesOnVm).toEqual([{ at: "2026-10-04T09:41:30.000Z", title: "Azure reported a problem with the VM" }]);
  });

  it("an outside change to the NSG writes one watchman note once per correlationId", async () => {
    const { env } = azureEnv();
    await running(env);
    await only(env);
    await runInsights(env, NOW);
    // The person's NSG change; the disk change by the same person is not one of the watched resources.
    expect(await notes(env)).toEqual([{ kind: "drift", message: expect.stringContaining("someone@example.net") }]);
    expect((await notes(env))[0]!.message).toMatch(/Network security group nsg-wg/);
    // The same events again next run: no second note, no duplicate rows.
    await setFeed(env, "activity", { status: "ok", next_due_at: ago(1), last_ok_at: ago(5) });
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    expect(await notes(env)).toHaveLength(1);
    expect((await stored(env)).filter((r) => r.correlation_id === "aaaaaaaa-0000-0000-0000-000000000001")).toHaveLength(1);
  });

  it("a later Started event never replaces the final status", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env);
    await runInsights(env, NOW);
    const late = fixture("activity");
    late.value = [late.value[1]]; // only the Started event of the NSG change
    delete late.nextLink;
    az.handlers.push((c) => (c.url.includes("eventtypes/management/values") ? json(late) : undefined));
    await setFeed(env, "activity", { status: "ok", next_due_at: ago(1), last_ok_at: ago(5) });
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    const nsg = (await stored(env)).filter((r) => r.correlation_id === "aaaaaaaa-0000-0000-0000-000000000001");
    expect(nsg).toEqual([expect.objectContaining({ status: "Succeeded" })]);
  });

  it("wg-admin's own changes write no note", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env);
    const mine = fixture("activity");
    mine.value = mine.value.filter((e: any) => e.caller === CLIENT);
    delete mine.nextLink;
    az.handlers.push((c) => (c.url.includes("eventtypes/management/values") ? json(mine) : undefined));
    await runInsights(env, NOW);
    expect((await stored(env)).length).toBe(2);
    expect(await notes(env)).toEqual([]);
  });

  it("cadence: 5 min while the RG exists or within 2 h of a run, else 60 min", async () => {
    const now = NOW.getTime();
    const destroyed = { state: "destroyed" as const, since: ago(300), azure: null };
    expect(activityCadence({ ...(await snapOf(destroyed)) }, null, now)).toBe(60);
    expect(activityCadence(await snapOf(destroyed), ago(119), now)).toBe(5);
    expect(activityCadence(await snapOf(destroyed), ago(121), now)).toBe(60);
    expect(activityCadence(await snapOf({ state: "running", since: ago(300) }), null, now)).toBe(5);

    // In a run: the next due time follows it.
    const { env } = azureEnv();
    await saveSnapshot(env, { state: "destroyed", since: ago(600) });
    await only(env);
    await runInsights(env, NOW);
    expect((await feedRows(env)).activity.next_due_at).toBe(iso(now + 60 * MIN));
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at, finished_at) VALUES ('r1', 'destroy', 'success', ?1, ?2)").bind(ago(50), ago(30)).run();
    await setFeed(env, "activity", { status: "ok", next_due_at: ago(1), last_ok_at: ago(60) });
    await runInsights(env, NOW);
    expect((await feedRows(env)).activity.next_due_at).toBe(iso(now + 5 * MIN));
  });

  it("at most 2 pages", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await only(env);
    await runInsights(env, NOW);
    const calls = callsTo(az, "eventtypes/management/values");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.u.searchParams.get("$skipToken")).toBe("page2");
    // The page-2 row is stored too.
    expect((await stored(env)).some((r) => r.resource_type === "Disk")).toBe(true);
    // The query: the resource group, from 10 minutes before the last success, only the fields used.
    const q = calls[0]!.u.searchParams;
    expect(q.get("api-version")).toBe("2015-04-01");
    expect(q.get("$filter")).toBe(`eventTimestamp ge '${iso(NOW.getTime() - 15 * MIN)}' and eventTimestamp le '${NOW.toISOString()}' and resourceGroupName eq 'rg-wg-ondemand'`);
    expect(q.get("$select")).toBe("eventDataId,eventTimestamp,operationName,status,caller,resourceId,category,correlationId,level,subStatus");
    expect(calls[0]!.url).not.toMatch(/\+/); // spaces sent as %20
    expect(activityQuery("rg", NOW.getTime() - 10 * MIN, NOW.getTime())).toContain("%20and%20");
  });
});

async function snapOf(over: any) {
  const { EMPTY } = await import("../src/state");
  return { ...EMPTY, ...over };
}
