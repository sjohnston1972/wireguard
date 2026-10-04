// insights-health.test.ts
//
// Plain English: the health feed (plan X1.2): what Azure says about the VM
// (Resource Health) and how the VM stands (power, provisioning, the VM
// agent, boot diagnostics), stored as az_latest['health'].
import { describe, it, expect, afterEach, vi } from "vitest";
import { normaliseHealth, fetchHealth } from "../src/insights/feeds/health";
import { runInsights } from "../src/insights/runner";
import { saveSnapshot } from "../src/state";
import { azureEnv, running, allNotDue, setFeed, feedRows, latest, callsTo, fixture, NOW, ago } from "./insights-helpers";

afterEach(() => vi.unstubAllGlobals());

describe("health feed", () => {
  it("normalise reads availabilityState, title, summary, reasonType and occurredTime", () => {
    const doc = normaliseHealth(fixture("availability-current"), fixture("vm-instanceview"), NOW);
    expect(doc).toMatchObject({
      state: "Degraded",
      title: "Degraded",
      summary: "We're sorry, your virtual machine is degraded because the host it runs on has a hardware fault.",
      reason: "Unplanned",
      since: "2026-10-04T09:41:00.000Z",
      checkedAt: NOW.toISOString(),
    });
    // Either spelling of Azure's occurred time; an empty reason is null; an unknown state is Unknown.
    const other = normaliseHealth({ properties: { availabilityState: "Weird", title: " ", reasonType: "", occurredTime: "2026-10-04T08:00:00Z" } }, fixture("vm-instanceview"), NOW);
    expect(other).toMatchObject({ state: "Unknown", title: null, reason: null, since: "2026-10-04T08:00:00.000Z" });
    // No Resource Health answer (a brand-new VM): Unknown, the rest still read.
    const none = normaliseHealth(null, fixture("vm-instanceview"), NOW);
    expect(none).toMatchObject({ state: "Unknown", title: null, summary: null, power: "VM running" });
    // Long text is capped.
    const long = normaliseHealth({ properties: { availabilityState: "Available", summary: "x".repeat(5000) } }, null, NOW);
    expect(long.summary!.length).toBeLessThanOrEqual(1000);
  });

  it("instance view gives power, provisioning, VM agent status and version, and boot diagnostics on or off", () => {
    const doc = normaliseHealth(fixture("availability-current"), fixture("vm-instanceview"), NOW);
    expect(doc).toMatchObject({ power: "VM running", provisioning: "Provisioning succeeded", vmAgent: { status: "Ready", version: "2.11.1.12" }, bootDiagnostics: true });

    const vm = fixture("vm-instanceview");
    vm.properties.diagnosticsProfile = { bootDiagnostics: { enabled: false } };
    vm.properties.instanceView.statuses[1] = { code: "PowerState/deallocated", displayStatus: "VM deallocated" };
    delete vm.properties.instanceView.vmAgent;
    expect(normaliseHealth(null, vm, NOW)).toMatchObject({ power: "VM deallocated", vmAgent: null, bootDiagnostics: false });

    // Built before boot diagnostics: no diagnosticsProfile at all is off.
    delete vm.properties.diagnosticsProfile;
    expect(normaliseHealth(null, vm, NOW).bootDiagnostics).toBe(false);
    // No VM reply: not known.
    expect(normaliseHealth(null, null, NOW)).toMatchObject({ power: null, provisioning: null, vmAgent: null, bootDiagnostics: null });
  });

  it("asks Resource Health and the VM with its instance view, two calls", async () => {
    const { env, az } = azureEnv();
    await running(env);
    await allNotDue(env);
    await setFeed(env, "health", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    const arm = callsTo(az, "management.azure.com");
    expect(arm.map((c) => decodeURIComponent(c.u.pathname + c.u.search))).toEqual([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wg-ondemand/providers/Microsoft.Compute/virtualMachines/vm-wg/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=2022-10-01",
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wg-ondemand/providers/Microsoft.Compute/virtualMachines/vm-wg?api-version=2024-07-01&$expand=instanceView",
    ]);
    expect((await feedRows(env)).health.status).toBe("ok");
    const doc = await latest(env, "health");
    expect(doc).toMatchObject({ state: "Degraded", power: "VM running", bootDiagnostics: true });
    expect(doc).not.toHaveProperty("annotations");
  });

  it("a VM that is not there yet stores nothing and is not an error", async () => {
    const { env, az } = azureEnv();
    await saveSnapshot(env, { state: "deploying", since: ago(2) });
    az.handlers.push((c) => (c.u.hostname === "management.azure.com" ? new Response(JSON.stringify({ error: { code: "ResourceNotFound" } }), { status: 404 }) : undefined));
    await allNotDue(env);
    await setFeed(env, "health", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    expect((await feedRows(env)).health.status).toBe("ok");
    expect(await latest(env, "health")).toBeNull();
  });

  it("runs only while the resource group exists", async () => {
    const { env, az } = azureEnv();
    await saveSnapshot(env, { state: "destroyed", since: ago(60) });
    await allNotDue(env);
    await setFeed(env, "health", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    expect(callsTo(az, "availabilityStatuses").length).toBe(0);
    await running(env);
    await runInsights(env, NOW);
    expect(callsTo(az, "availabilityStatuses").length).toBe(1);
    expect(typeof fetchHealth).toBe("function");
  });
});
