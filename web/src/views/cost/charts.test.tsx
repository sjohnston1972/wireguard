import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { costFixture } from "./testData";

const page = (cost = costFixture()) => renderApp("/cost", { routes: { "GET /api/v1/cost": cost } });

describe("Cost charts", () => {
  it("compare switch adds the previous series and is hidden without previous days", async () => {
    const { unmount } = page();
    const key = await screen.findByRole("list", { name: "Chart key" });
    expect(within(key).queryByText("Previous period")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Compare to previous period" }));
    expect(within(screen.getByRole("list", { name: "Chart key" })).getByText("Previous period")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Compare to previous period" }));
    expect(within(screen.getByRole("list", { name: "Chart key" })).queryByText("Previous period")).not.toBeInTheDocument();
    unmount();

    page(costFixture({ previous: [] }));
    await screen.findByRole("list", { name: "Chart key" });
    expect(screen.queryByRole("switch", { name: "Compare to previous period" })).not.toBeInTheDocument();
  });

  it("breakdown labelled Estimate when basis is estimate", async () => {
    page(
      costFixture({
        breakdown: { byType: [], byRegion: [{ location: "uksouth", name: "UK South (London)", gbp: 0.2, pct: 100 }], basis: "estimate", asOfDay: null },
      }),
    );
    const panel = within(await screen.findByRole("region", { name: "Spend breakdown" }));
    expect(panel.getAllByText("Estimate").length).toBeGreaterThan(0);
    expect(panel.getByText("UK South (London)")).toBeInTheDocument();
    expect(panel.queryByText(/Azure actual/)).not.toBeInTheDocument();
  });

  it("breakdown says Azure actual with its day when Azure has a split", async () => {
    page();
    const panel = within(await screen.findByRole("region", { name: "Spend breakdown" }));
    expect(panel.getByText(/Azure actual, as of 1 Oct/)).toBeInTheDocument();
    expect(panel.getByText("Compute (VM)")).toBeInTheDocument();
  });

  it("region and resource type toggle swap the bars", async () => {
    page();
    const panel = within(await screen.findByRole("region", { name: "Spend by region" }));
    expect(panel.getByText("UK South (London)")).toBeInTheDocument();
    expect(panel.queryByText("Compute (VM)")).not.toBeInTheDocument();
    await userEvent.click(panel.getByRole("radio", { name: "Resource type" }));
    const typed = within(screen.getByRole("region", { name: "Spend by resource type" }));
    expect(typed.getByText("Compute (VM)")).toBeInTheDocument();
    expect(typed.queryByText("UK South (London)")).not.toBeInTheDocument();
  });

  it("days with no figure are gaps, not zero bars", async () => {
    page();
    const fig = await screen.findByRole("figure", { name: "Daily spend" });
    // 1 and 2 Oct: Azure has listed the 1st only.
    expect(fig.querySelectorAll("svg rect")).toHaveLength(1);
    expect(fig).toHaveTextContent("1 day with no data");
  });
});
