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

  it("a budget with no actuals yet shows spent as no data, not £0.00", async () => {
    renderApp("/cost", {
      routes: { "GET /api/v1/cost": emptyCostFixture({ budget: { budget: 10, actual: 0, session: 0, total: 0, pct: 0, level: "ok", month: "2026-10", alerted: 0 } }) },
    });
    const t = await tile("Monthly budget");
    expect(t.getByText("£10.00")).toBeInTheDocument();
    expect(t.getByText("Spent").parentElement).toHaveTextContent("no data");
    expect(t.queryByText(/£0\.00/)).not.toBeInTheDocument();
    expect(t.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("Cost page: two clouds", () => {
  it("month to date names both clouds when AWS has spend, and is unchanged when it has none", async () => {
    const both = renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ byCloud: { azure: 1.2, aws: 0.4 } }) } });
    const t = await tile("Month to date (actual)");
    expect(t.getByText("Azure £1.20 · AWS £0.40")).toBeInTheDocument();
    both.unmount?.();
  });

  it("month to date names AWS when only AWS has figures", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ meta: { ...costFixture().meta, azureAsOfDay: null, awsAsOfDay: "2026-10-01" }, byCloud: { azure: 0, aws: 0.4 } }) } });
    const t = await tile("Month to date (actual)");
    expect(t.getByText(/AWS £0\.40 · actual, as of/)).toBeInTheDocument();
    expect(t.queryByText(/Azure actual/)).toBeNull();
  });

  it("month to date is cloud-neutral when a day was pulled but neither cloud has spend", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ byCloud: { azure: 0, aws: 0 } }) } });
    const t = await tile("Month to date (actual)");
    expect(t.getByText(/^Actual, as of/)).toBeInTheDocument();
    expect(t.queryByText(/Azure actual/)).toBeNull();
  });

  it("each cloud's line carries its own day: AWS's older pull never shows under an Azure label, nor Azure's under AWS (spec 10.3)", async () => {
    const meta = { ...costFixture().meta, asOfDay: "2026-10-01", azureAsOfDay: "2026-10-03", awsAsOfDay: "2026-10-01" };
    const azure = renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ meta, byCloud: { azure: 0.3, aws: 0 } }) } });
    let t = await tile("Month to date (actual)");
    expect(t.getByText("Azure actual, as of 3 Oct (UTC)")).toBeInTheDocument();
    azure.unmount?.();
    const meta2 = { ...meta, asOfDay: "2026-10-01", azureAsOfDay: "2026-10-01", awsAsOfDay: "2026-10-04" };
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ meta: meta2, byCloud: { azure: 0, aws: 0.4 } }) } });
    t = await tile("Month to date (actual)");
    expect(t.getByText("AWS £0.40 · actual, as of 4 Oct (UTC)")).toBeInTheDocument();
  });

  it("month to date keeps today's text with no AWS spend", async () => {
    renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ byCloud: { azure: 0.3, aws: 0 } }) } });
    const t = await tile("Month to date (actual)");
    expect(t.getByText(/Azure actual, as of/)).toBeInTheDocument();
    expect(t.queryByText(/AWS £/)).toBeNull();
  });
});
