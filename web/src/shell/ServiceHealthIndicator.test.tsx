// ServiceHealthIndicator.test.tsx
//
// Plain English: the top-bar Azure Service Health pill (insights spec 10.2)
// appears only while Azure has an active issue in the configured region.
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { azureSummaryFixture } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { issue } from "@/views/activity/azureKit";

vi.setConfig({ testTimeout: 20_000 });

const summary = (issues = [issue()]) => ({ "GET /api/v1/azure/summary": azureSummaryFixture({ serviceIssues: issues }) });
/** The shell has drawn and asked for the Azure summary. */
const settled = async () => {
  await screen.findAllByRole("link", { name: "Overview" });
  await new Promise((r) => setTimeout(r, 150));
};
const topbar = () => within(document.querySelector<HTMLElement>("header.topbar")!);

describe("the Service Health pill", () => {
  it("the pill renders nothing without an active regional issue", async () => {
    renderApp("/settings", { routes: summary([]) });
    await settled();
    expect(topbar().queryByRole("button", { name: /Azure issue/ })).toBeNull();
  });

  it("renders nothing while Azure is not connected", async () => {
    renderApp("/settings");
    await settled();
    expect(topbar().queryByRole("button", { name: /Azure issue/ })).toBeNull();
  });

  it("amber for an issue, red at level Error", async () => {
    const a = renderApp("/settings", { routes: summary() });
    const pill = await topbar().findByRole("button", { name: "Azure issue in UK South" });
    expect(pill).toHaveAttribute("data-tone", "amber");
    expect(pill).toHaveTextContent("Azure issue in UK South");
    a.unmount();
    renderApp("/settings", { routes: summary([issue({ level: "Error" })]) });
    const red = await topbar().findByRole("button", { name: "Serious Azure issue in UK South" });
    expect(red).toHaveAttribute("data-tone", "red");
    expect(red).toHaveTextContent("Serious Azure issue");
  });

  it("planned maintenance does not light it", async () => {
    renderApp("/settings", { routes: summary([issue({ type: "PlannedMaintenance", level: null })]) });
    await settled();
    expect(topbar().queryByRole("button", { name: /Azure issue/ })).toBeNull();
  });

  it("popover lists title, services, start, last update and summary, and links to Activity", async () => {
    renderApp("/settings", { routes: summary() });
    await userEvent.click(await topbar().findByRole("button", { name: "Azure issue in UK South" }));
    const pop = await screen.findByRole("dialog", { name: "Azure service health" });
    expect(pop).toHaveTextContent("Virtual Machines: connectivity problems");
    expect(within(pop).getByText("Services").nextElementSibling).toHaveTextContent("Virtual Machines");
    expect(within(pop).getByText("Started")).toBeInTheDocument();
    expect(within(pop).getByText("Last update")).toBeInTheDocument();
    expect(pop).toHaveTextContent("Some VMs in UK South may fail to start.");
    expect(within(pop).getByRole("link", { name: /service health on Activity/i })).toHaveAttribute("href", "/activity?widget=serviceHealth");
  });

  it("keyboard and screen-reader name", async () => {
    renderApp("/settings", { routes: summary() });
    const pill = await topbar().findByRole("button", { name: "Azure issue in UK South" });
    pill.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Azure service health" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Azure service health" })).toBeNull();
  });

  it("phone: the pill shows on the top bar", async () => {
    setViewport("phone");
    renderApp("/settings", { routes: summary() });
    expect(await topbar().findByRole("button", { name: "Azure issue in UK South" })).toBeInTheDocument();
  });
});
