import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activityResponse, activityRoutes, emptyActivity, emptyKpis, kpis } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

const group = (name: string) => screen.findByRole("group", { name });

describe("Activity header and figures", () => {
  it("range select updates the URL and refetches", async () => {
    const { fetchMock } = renderApp("/activity", { routes: activityRoutes() });
    await group("Deploys");
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=7d")).toBe(true);

    await userEvent.click(screen.getByRole("combobox", { name: "Range" }));
    await userEvent.click(await screen.findByRole("option", { name: "Last 24 hours" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "location" })).toHaveTextContent("/activity?range=24h"));
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=24h")).toBe(true));
  });

  it("opens on the range in the address", async () => {
    const { fetchMock } = renderApp("/activity?range=30d", { routes: activityRoutes() });
    await group("Deploys");
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/activity?range=30d")).toBe(true);
    expect(screen.getByRole("combobox", { name: "Range" })).toHaveTextContent("Last 30 days");
  });

  it("the refresh button asks the API again", async () => {
    const { fetchMock } = renderApp("/activity", { routes: activityRoutes() });
    await group("Deploys");
    const before = fetchMock!.calls.filter((c) => c.url.startsWith("/api/v1/activity")).length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock!.calls.filter((c) => c.url.startsWith("/api/v1/activity")).length).toBeGreaterThan(before));
  });

  it("KPIs show deltas against previous and no delta when previous is empty", async () => {
    renderApp("/activity", { routes: activityRoutes() });
    const deploys = await group("Deploys");
    expect(deploys).toHaveTextContent("4");
    expect(deploys).toHaveTextContent("100% vs previous period");
    // The median fell from 3m 0s to 2m 18s: down 23 %.
    const median = screen.getByRole("group", { name: "Median deploy duration" });
    expect(median).toHaveTextContent("2m 18s");
    expect(median).toHaveTextContent("23% vs previous period");
    expect(within(median).getByText("down")).toBeInTheDocument();
    // 96 % against 90 %.
    expect(screen.getByRole("group", { name: "Success rate" })).toHaveTextContent("6 pts vs previous period");
    expect(screen.getByRole("group", { name: "Success rate" })).toHaveTextContent("44 successful / 46 total");
    // Same count as before: nothing to say.
    expect(screen.getByRole("group", { name: "Failed runs" })).not.toHaveTextContent("vs previous");
    expect(screen.getByRole("group", { name: "Config changes" })).toHaveTextContent("50% vs previous period");
    expect(screen.getByRole("group", { name: "Watchman problems" })).toHaveTextContent("1");
  });

  it("no delta when the previous period had nothing to compare", async () => {
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": activityResponse({ previous: emptyKpis() }) }) });
    await group("Deploys");
    for (const name of ["Deploys", "Median deploy duration", "Success rate", "Failed runs", "Config changes", "Watchman problems"]) {
      expect(screen.getByRole("group", { name })).not.toHaveTextContent("vs previous");
    }
  });

  it("success rate with no finished runs shows no data", async () => {
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    const rate = await group("Success rate");
    expect(rate).toHaveTextContent("no data");
    expect(rate).not.toHaveTextContent("0%");
    expect(within(rate).queryByRole("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Median deploy duration" })).toHaveTextContent("no data");
  });

  it("failed runs go red only when they rose", async () => {
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": activityResponse({ kpis: kpis({ failedRuns: 5 }) }) }) });
    const failed = await group("Failed runs");
    expect(failed).toHaveTextContent("150% vs previous period");
    expect(failed).toHaveTextContent("up");
  });
});
