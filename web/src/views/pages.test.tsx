import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import * as pages from "./pages";
import * as overview from "./overview";
import * as clients from "./clients";
import * as firewall from "./firewall";
import * as activity from "./activity";
import * as cost from "./cost";
import * as settings from "./settings";

// Each view lives in its own folder (views/<view>/index.tsx); pages.tsx only
// re-exports them, so the route table in App.tsx never changes.

describe("view folders", () => {
  it("pages.tsx re-exports each view folder's pages", () => {
    expect(pages.OverviewPage).toBe(overview.OverviewPage);
    expect(pages.ClientsPage).toBe(clients.ClientsPage);
    expect(pages.ClientDetailPage).toBe(clients.ClientDetailPage);
    expect(pages.FirewallPage).toBe(firewall.FirewallPage);
    expect(pages.FirewallRulePage).toBe(firewall.FirewallRulePage);
    expect(pages.ActivityPage).toBe(activity.ActivityPage);
    expect(pages.RunDetailPage).toBe(activity.RunDetailPage);
    expect(pages.CostPage).toBe(cost.CostPage);
    expect(pages.SettingsPage).toBe(settings.SettingsPage);
  });

  it.each([
    ["/", "Overview"],
    ["/clients", "Clients"],
    ["/clients/3", "Client 3"],
    ["/activity", "Activity"],
    ["/activity/runs/12", "Run 12"],
    ["/cost", "Cost"],
    ["/settings", "Settings"],
    ["/settings/automation", "Settings"],
    ["/nowhere", "Not found"],
  ])("%s still shows its placeholder", (url, title) => {
    renderApp(url);
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(main).toHaveTextContent("Built in plan 4");
  });
});
