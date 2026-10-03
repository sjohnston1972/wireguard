import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { activityRoutes } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

// One-screen rule at the boundary (1100 x 600): the runs table is the list
// that matters. The bottom row (Run details, Live output) repeats what the
// run drawer shows, so on a short window it gives its height to the table.
describe("activity on a short desktop window", () => {
  it("leaves Run details and Live output to the run drawer, so the table gets the room", async () => {
    setViewport([1100, 600]);
    renderApp("/activity", { routes: activityRoutes() });
    expect(await screen.findByRole("table", { name: "Runs" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Run details/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /Live output/ })).toBeNull();
  });

  it("a tall window keeps them under the table", async () => {
    setViewport([1600, 900]);
    renderApp("/activity", { routes: activityRoutes() });
    expect(await screen.findByRole("region", { name: /Run details/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Live output/ })).toBeInTheDocument();
  });
});
