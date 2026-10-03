import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { firewallData } from "./testData";

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// One-screen rule at the boundary (1100 x 600): the rules table is the list
// that matters, so it gets the whole left column; zones and the simulator
// become tabs in the right column instead of a row under the table.
describe("firewall on a short desktop window", () => {
  it("zones and the simulator are right-hand tabs, and Test simulation opens the simulator", async () => {
    setViewport([1100, 600]);
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    await screen.findByRole("table", { name: "Firewall rules" });
    expect(screen.queryByRole("region", { name: "Network zones" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Test specific traffic" })).toBeNull();
    const tabs = screen.getByRole("tablist", { name: /zones and simulator/ });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^Drops/), "Ports", "Capture", "Zones", "Test"]));

    fireEvent.click(screen.getByRole("button", { name: "Test simulation" }));
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Test" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(screen.getByRole("tabpanel")).toContainElement(document.activeElement as HTMLElement));
  });

  it("a tall window keeps zones and the simulator under the table", async () => {
    setViewport([1600, 900]);
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    expect(await screen.findByRole("region", { name: "Network zones" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Test specific traffic" })).toBeInTheDocument();
  });
});
