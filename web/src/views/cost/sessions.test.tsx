import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { costFixture } from "./testData";

const runDetail = {
  run: { id: "run-3", action: "apply", status: "success", requested_at: "2026-10-02T09:38:00.000Z", requested_by: "dev@localhost", started_at: "2026-10-02T09:38:30.000Z", finished_at: "2026-10-02T09:41:00.000Z", github_run_url: null, public_ip: "203.0.113.7", reason: null, error: null, durationSeconds: 150, sessionCostGbp: 0.2, source: "dashboard" },
  steps: [],
  active: false,
};

const open = () => renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture(), "GET /api/v1/runs/run-3": runDetail } });
const table = async () => within(await screen.findByRole("table", { name: "Sessions" }));

describe("Cost sessions", () => {
  it("chips and search filter sessions; a running session says running", async () => {
    open();
    const t = await table();
    expect(t.getAllByRole("row")).toHaveLength(4); // header + 3
    const running = t.getByRole("row", { name: /2 Oct, 09:41/ });
    expect(within(running).getByText("Running")).toBeInTheDocument();

    const chips = within(screen.getByRole("group", { name: "Session status" }));
    await userEvent.click(chips.getByRole("button", { name: "Ended" }));
    expect(t.getAllByRole("row")).toHaveLength(3);
    expect(t.queryByText("Running")).not.toBeInTheDocument();
    await userEvent.click(chips.getByRole("button", { name: "Running" }));
    expect(t.getAllByRole("row")).toHaveLength(2);
    await userEvent.click(chips.getByRole("button", { name: "All" }));

    await userEvent.type(screen.getByRole("searchbox", { name: "Search sessions" }), "B2s");
    expect(t.getAllByRole("row")).toHaveLength(2);
    expect(t.getByText("25 Sep, 10:52")).toBeInTheDocument();
  });

  it("filters by region", async () => {
    open();
    const t = await table();
    const trigger = screen.getByRole("combobox", { name: "Session region" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("option", { name: "North Europe" }));
    expect(t.getAllByRole("row")).toHaveLength(2);
    expect(t.getByText("26 Sep, 13:34")).toBeInTheDocument();
  });

  it("a session opens its drawer with its run", async () => {
    const { fetchMock } = open();
    const t = await table();
    await userEvent.click(t.getByText("2 Oct, 09:41"));
    const drawer = within(await screen.findByRole("dialog"));
    expect(await drawer.findByText("dev@localhost")).toBeInTheDocument();
    expect(drawer.getByText("203.0.113.7")).toBeInTheDocument();
    expect(drawer.getByRole("link", { name: /Open the run in Activity/ })).toHaveAttribute("href", "/activity/runs/run-3");
    expect(drawer.getByText(/not recorded per session/)).toBeInTheDocument();
    expect(fetchMock!.callsTo("GET", "/api/v1/runs/run-3")).toHaveLength(1);
  });
});
