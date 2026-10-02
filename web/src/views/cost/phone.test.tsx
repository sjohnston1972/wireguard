import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { costFixture } from "./testData";

describe("Cost on the phone", () => {
  it("phone shows totals and opens sessions in a sheet", async () => {
    setViewport("phone");
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture() } });
    const budget = within(await screen.findByRole("group", { name: "Monthly budget" }));
    expect(budget.getByRole("progressbar")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "This session" })).getByText("£0.20")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Month to date (actual)" })).getByText("£0.30")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Sessions" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const sheet = within(await screen.findByRole("dialog"));
    expect(sheet.getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(sheet.getByText("25 Sep, 10:52")).toBeInTheDocument();
  });

  it("phone opens the spend chart in a sheet", async () => {
    setViewport("phone");
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture() } });
    await screen.findByRole("group", { name: "Monthly budget" });
    expect(screen.queryByRole("figure", { name: "Daily spend" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Spend over time" }));
    expect(await within(await screen.findByRole("dialog")).findByRole("figure", { name: "Daily spend" })).toBeInTheDocument();
  });
});
