// traffic-stale.test.tsx
//
// Plain English: once nothing is running, the Network traffic chart must not
// keep drawing the last session's samples (GitHub issue #116).
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { NOW_MS, overview, prefsRoutes } from "./testData";

const hist = [0, 6, 7, 4].map((v, i) => ({ t: new Date(NOW_MS - (4 - i) * 30_000).toISOString(), rx: v, tx: v + 1 }));
const panel = () => screen.findByRole("region", { name: "Network traffic" });

describe("Network traffic after a tear-down", () => {
  it("a destroyed headend shows no chart, whatever traffic_hist still holds", async () => {
    renderApp("/", { routes: prefsRoutes(overview("destroyed", { snapshot: { traffic_hist: hist } }), {}) });
    const p = await panel();
    expect(await within(p).findByText("No traffic: nothing is running")).toBeInTheDocument();
    expect(within(p).queryByTestId("chart-summary")).toBeNull();
  });

  it("a running headend with the same samples still draws the chart", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist } }), {}) });
    const p = await panel();
    await waitFor(() => expect(within(p).getByTestId("chart-summary")).toBeInTheDocument());
    expect(within(p).queryByText("No traffic: nothing is running")).toBeNull();
  });
});
