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

  it("an unknown address shows the not-found placeholder inside the shell", () => {
    renderApp("/nowhere");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(main).toHaveTextContent("Built in plan 4");
  });

  // Every real route shows its view, never the placeholder (default fixtures: a running session).
  it.each([
    ["/", "Overview"],
    ["/clients", "Clients"],
    ["/clients/1", "Clients"],
    ["/firewall", "Firewall"],
    ["/activity", "Activity"],
    ["/cost", "Cost"],
    ["/settings", "Settings"],
    ["/settings/automation", "Settings"],
  ])("%s shows its real view, not a placeholder", async (url, title) => {
    renderApp(url);
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(main).not.toHaveTextContent("Built in plan 4");
  });

  // These two open a modal drawer over their page, which hides the page from the accessibility tree.
  it.each([
    ["/activity/runs/run-42", /Run/, "Activity"],
    ["/firewall/rules/7", /Allow DNS to resolver/, "Firewall"],
  ])("%s opens a modal drawer over its real page", async (url, drawer, title) => {
    renderApp(url);
    expect(await screen.findByRole("dialog", { name: drawer })).toBeInTheDocument();
    const main = screen.getByRole("main", { hidden: true });
    expect(within(main).getByRole("heading", { level: 1, name: title, hidden: true })).toBeInTheDocument();
    expect(main).not.toHaveTextContent("Built in plan 4");
  });
});
