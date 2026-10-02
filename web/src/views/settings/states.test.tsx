import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { routesFor, settingsFixture } from "./testkit";

// Spec 10: every view shows a shape-matched skeleton while loading, an error
// with the API's own words and a working Retry, and an empty state that names
// what is empty and what to do next.

describe("Settings states", () => {
  it("shows a shape-matched Skeleton while loading", async () => {
    const never = () => new Promise(() => {});
    const { container } = renderApp("/settings", { routes: { ...routesFor(), "GET /api/v1/settings": never } });
    const loading = await screen.findByLabelText("Loading settings");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThanOrEqual(4);
    // The title is already there: the page does not jump when the data lands.
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows the API's message on a 500, and Retry fetches again", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { fetchMock } = renderApp("/settings", {
      routes: { ...routesFor(), "GET /api/v1/settings": () => (fail ? { status: 500, json: { error: { code: "internal", message: "The settings database is unavailable." } } } : settingsFixture()) },
    });
    expect(await screen.findByText("The settings database is unavailable.")).toBeInTheDocument();
    const before = fetchMock!.callsTo("GET", "/api/v1/settings").length;
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/settings").length).toBeGreaterThan(before));
    expect(await screen.findByRole("tab", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByText("The settings database is unavailable.")).toBeNull();
  });

  it("names what is empty and the next action: no schedules, no profiles, no backups, no phones", async () => {
    const user = userEvent.setup();
    const empty = settingsFixture({
      schedules: [],
      profiles: [],
      phones: [],
      nextScheduledStart: null,
      backups: { state: { count: 0, newest: null }, config: { count: 0, newest: null, days: [] }, checked_at: "2026-10-02T11:59:00.000Z" },
    });
    const { unmount } = renderApp("/settings/automation", { routes: routesFor(empty) });
    expect(await screen.findByText("No schedules")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a schedule" }));
    expect(await screen.findByRole("dialog", { name: "Add a schedule" })).toBeInTheDocument();
    unmount();

    const r2 = renderApp("/settings/deployment", { routes: routesFor(empty) });
    expect(await screen.findByText("No profiles yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeInTheDocument();
    r2.unmount();

    const r3 = renderApp("/settings/backup", { routes: routesFor(empty) });
    expect(await screen.findByText("No nightly backups yet")).toBeInTheDocument();
    r3.unmount();

    renderApp("/settings/mobile", { routes: routesFor(empty) });
    expect(await screen.findByText("No phones signed up")).toBeInTheDocument();
  });

  it("says no data, not a made-up state, when the VM has not reported", async () => {
    renderApp("/settings", { routes: { ...routesFor(), "GET /api/v1/overview": { status: 500, json: { error: { code: "internal", message: "down" } } } } });
    // Settings still show; the live lights say there is nothing to report.
    expect(await screen.findByText("Settings overview")).toBeInTheDocument();
    expect((await screen.findAllByText("no data")).length).toBeGreaterThan(0);
  });
});
