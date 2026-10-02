import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activityResponse, activityRoutes, emptyActivity } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

describe("Activity states", () => {
  it("shows shape-matched skeletons while loading", async () => {
    const never = new Promise(() => {});
    const { container } = renderApp("/activity", { routes: { "GET /api/v1/activity": () => never } });
    const kpis = await screen.findByRole("region", { name: "Key figures" }).catch(() => container.querySelector(".act__kpis"));
    expect(kpis).toHaveAttribute("aria-busy", "true");
    expect(kpis!.querySelectorAll(".skeleton--tile")).toHaveLength(6);
    // The header is already there, and no figure is invented.
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("an API failure shows its message and Retry loads again", async () => {
    let fail = true;
    const { fetchMock } = renderApp("/activity", {
      routes: activityRoutes({
        "GET /api/v1/activity": () => (fail ? { status: 500, json: { error: { code: "internal", message: "The database is unavailable." } } } : activityResponse()),
      }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The database is unavailable.");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Deploys" })).toBeInTheDocument();
    expect(fetchMock!.calls.filter((c) => c.url.startsWith("/api/v1/activity")).length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("an empty range names what is empty and the next step", async () => {
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(within(table).getByText("No runs in this range")).toBeInTheDocument();
    expect(within(table).getByText(/Deploy from Overview/)).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "Open Overview" }));
    expect(screen.getByRole("status", { name: "location" })).toHaveTextContent(/^\/$/);
  });

  it("an empty stream and change log say so", async () => {
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    const stream = await screen.findByRole("region", { name: "Live event stream" });
    expect(within(stream).getByText("No events")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Change log" })).getByText("No changes")).toBeInTheDocument();
  });

  it("an empty watchman tab names what is empty", async () => {
    renderApp("/activity?tab=notes", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    expect(await screen.findByText("No watchman notes in this range")).toBeInTheDocument();
  });
});
