// insightsLazy.test.tsx
//
// Plain English: the Azure insights widgets are code-split (insights plan,
// integration). Their modules load only when a widget is turned on or the
// boot log is opened, so today's default pages never fetch them and the
// main bundle stays small. Each module below is wrapped so the test sees the
// moment it is first imported.
import "./overview/testSetup";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { PagePrefs } from "@shared/api";
import { renderApp } from "@/test/render";
import { azureSummaryFixture, prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { overview, prefsRoutes } from "./overview/testData";
import { firewallData } from "./firewall/testData";
import { activityRoutes } from "./activity/testkit";

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("@/views/overview/Insights", async (orig) => (loaded.add("overview/Insights"), orig()));
vi.mock("@/views/overview/BootLog", async (orig) => (loaded.add("overview/BootLog"), orig()));
vi.mock("@/views/firewall/PublicIp", async (orig) => (loaded.add("firewall/PublicIp"), orig()));
vi.mock("@/views/activity/AzureChanges", async (orig) => (loaded.add("activity/AzureChanges"), orig()));
vi.mock("@/views/activity/ServiceHealth", async (orig) => (loaded.add("activity/ServiceHealth"), orig()));
vi.mock("@/views/activity/PhoneAzure", async (orig) => (loaded.add("activity/PhoneAzure"), orig()));
vi.mock("@/views/activity/ServiceHealthLink", async (orig) => (loaded.add("activity/ServiceHealthLink"), orig()));
vi.mock("@/shell/ServiceHealthPill", async (orig) => (loaded.add("shell/ServiceHealthPill"), orig()));
vi.mock("@/widgets/WidgetLibrary", async (orig) => (loaded.add("widgets/WidgetLibrary"), orig()));

vi.setConfig({ testTimeout: 20_000 });

const settle = () => new Promise((r) => setTimeout(r, 100));

describe("the Azure insights widgets load only when used", () => {
  it("with no prefs, Overview, Firewall and Activity (desktop and phone) load none of their modules", async () => {
    const a = renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    await screen.findByRole("region", { name: "Network traffic" });
    await settle();
    a.unmount();
    const b = renderApp("/firewall", { routes: { ...prefsServer({}).routes, "GET /api/v1/firewall": firewallData() } });
    await screen.findByRole("region", { name: "Packet capture" });
    await settle();
    b.unmount();
    const c = renderApp("/activity", { routes: activityRoutes(prefsServer({}).routes) });
    await screen.findByRole("table", { name: "Runs" });
    await settle();
    c.unmount();
    setViewport("phone");
    const d = renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    await screen.findByRole("region", { name: "Environment status" });
    await settle();
    d.unmount();
    expect([...loaded]).toEqual([]);
  });

  it("turning VM performance on loads the Overview insights module and shows the widget", async () => {
    const on: PagePrefs = { layout: { hidden: ["overview.traffic"], shown: ["overview.vmPerformance"] } };
    renderApp("/", { routes: prefsRoutes(overview("running"), on, { "GET /api/v1/azure/summary": azureSummaryFixture() }) });
    expect(await screen.findByRole("region", { name: "VM performance" })).toBeInTheDocument();
    expect(loaded.has("overview/Insights")).toBe(true);
    expect(loaded.has("firewall/PublicIp")).toBe(false);
  });
});
