import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { costFixture, emptyCostFixture } from "./testData";

const tile = async (name: string) => within(await screen.findByRole("group", { name }));

describe("Cost page header and tiles", () => {
  it("range select updates the URL and refetches", async () => {
    const { fetchMock } = renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture() } });
    await screen.findByRole("group", { name: "Monthly budget" });
    expect(fetchMock!.callsTo("GET", "/api/v1/cost").some((c) => c.url.includes("range=month"))).toBe(true);
    const trigger = screen.getByRole("combobox", { name: "Range" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("option", { name: "Last 7 days" }));
    expect(screen.getByLabelText("location")).toHaveTextContent("/cost?range=7d");
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/cost").some((c) => c.url.includes("range=7d"))).toBe(true));
  });

  it("budget shows spent and projected as two figures", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture() } });
    const t = await tile("Monthly budget");
    expect(t.getByText("£0.50")).toBeInTheDocument();
    expect(t.getByText("Spent")).toBeInTheDocument();
    expect(t.getByText("£9.30")).toBeInTheDocument();
    expect(t.getByText("Projected")).toBeInTheDocument();
    expect(t.getByText("£10.00")).toBeInTheDocument();
    expect(t.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
  });

  it("projection tooltip states its basis", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture() } });
    const t = await tile("Estimated this month");
    expect(t.getByText("£9.30")).toBeInTheDocument();
    await userEvent.hover(t.getByRole("button", { name: "How this is estimated" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("carried on at the same pace to all 31 days");
  });

  it("no actuals and no sessions shows no data in every tile and the donut", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": emptyCostFixture() } });
    for (const name of ["This session", "Month to date (actual)", "Estimated this month", "Monthly budget", "Cost guard"]) {
      const t = await tile(name);
      expect(t.getByText("no data")).toBeInTheDocument();
      expect(t.queryByText(/£0\.00/)).not.toBeInTheDocument();
    }
    const donut = within(screen.getByRole("region", { name: "Spend breakdown" }));
    expect(donut.getByText("no data")).toBeInTheDocument();
    expect(donut.queryByText(/0%/)).not.toBeInTheDocument();
  });
});
