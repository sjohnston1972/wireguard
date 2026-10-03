import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { costFixture } from "./testData";

describe("Cost states", () => {
  it("shows shape-matched skeletons while loading", async () => {
    const { container } = renderApp("/cost", { routes: { "GET /api/v1/cost": () => new Promise(() => {}) } });
    expect(await screen.findByRole("heading", { level: 1, name: "Cost" })).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton--tile")).toHaveLength(5);
    expect(screen.queryByRole("group", { name: "Monthly budget" })).not.toBeInTheDocument();
  });

  it("shows the API message and a working Retry on a 500", async () => {
    let fail = true;
    const { fetchMock } = renderApp("/cost", {
      routes: { "GET /api/v1/cost": () => (fail ? { status: 500, json: { error: { code: "server", message: "Azure cost data is unavailable." } } } : costFixture()) },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Azure cost data is unavailable.");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Monthly budget" })).toBeInTheDocument();
    expect(fetchMock!.callsTo("GET", "/api/v1/cost").length).toBeGreaterThan(1);
  });

  it("names what is empty and the next step when there are no sessions", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ sessions: [] }) } });
    const t = within(await screen.findByRole("table", { name: "Sessions" }));
    expect(t.getByText("No sessions yet")).toBeInTheDocument();
    expect(t.getByRole("button", { name: "Deploy from Overview" })).toBeInTheDocument();
  });

  it("insights say so when there are none", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ insights: [] }) } });
    const panel = within(await screen.findByRole("region", { name: "Insights" }));
    expect(panel.getByText("Nothing to point out")).toBeInTheDocument();
  });
});
