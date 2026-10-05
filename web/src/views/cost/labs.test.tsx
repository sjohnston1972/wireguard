// labs.test.tsx
//
// Plain English: the Cost page's Labs panel (widget cost.labs, Labs spec
// section 10). Off until turned on; then this month's spend per lab, Azure's
// actual plus the estimate for what Azure has not caught up with.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { CostResponse, LabCostRow, PagePrefs } from "@shared/api";
import { renderApp } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { costFixture } from "./testData";

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import("./LabsPanel");
});

const rows: LabCostRow[] = [
  { labId: "az104-05-storage", title: "Storage tiers and lifecycle", actualGbp: 0.04, estimateGbp: null, totalGbp: 0.04, sessions: 1, running: false },
  { labId: "az104-06-blob-security", title: "Blob security", actualGbp: 0.2, estimateGbp: 0.0071, totalGbp: 0.2071, sessions: 2, running: true },
  { labId: "az104-04-budgets", title: "Budgets and action groups", actualGbp: null, estimateGbp: 0.11, totalGbp: 0.11, sessions: 1, running: false },
];
const ON: PagePrefs = { layout: { hidden: ["cost.insights"], shown: ["cost.labs"] } };
const page = (prefs: PagePrefs = {}, labs: LabCostRow[] = rows) => renderApp("/cost", { routes: { "GET /api/v1/cost": costFixture({ labs } as Partial<CostResponse>), ...prefsServer({ cost: prefs }).routes } });
const panel = async () => within(await screen.findByRole("region", { name: "Labs" }));

describe("Cost: Labs panel", () => {
  it("cost.labs is off by default", async () => {
    page();
    await screen.findByRole("region", { name: "Spend over time" });
    expect(screen.queryByRole("region", { name: "Labs" })).toBeNull();
    expect(screen.getByRole("region", { name: "Insights" })).toBeInTheDocument();
  });

  it("cost.labs lists this month per lab, actual plus running estimate, largest first", async () => {
    page(ON);
    const p = await panel();
    const items = await p.findAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Blob security", "Budgets and action groups", "Storage tiers and lifecycle"]);
    expect(items[0]).toHaveTextContent("£0.21");
    expect(items[0]).toHaveTextContent("actual £0.20");
    expect(items[0]).toHaveTextContent("estimate £0.007");
    expect(items[0]).toHaveTextContent("running now");
    expect(items[1]).toHaveTextContent("no actual yet");
    expect(items[1]).toHaveTextContent("estimate £0.11");
    expect(items[2]).toHaveTextContent("actual £0.04");
    expect(items[2]).not.toHaveTextContent("estimate");
  });

  it("order by lab number and hiding running estimates", async () => {
    page({ ...ON, widgets: { "cost.labs": { v: 1, s: { order: "lab", estimates: false } } } });
    const p = await panel();
    const items = await p.findAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Budgets and action groups", "Storage tiers and lifecycle", "Blob security"]);
    expect(items[2]).toHaveTextContent("£0.20");
    expect(items[2]).not.toHaveTextContent("estimate");
    expect(items[0]).toHaveTextContent("no actual yet");
  });

  it("says so when no lab ran this month", async () => {
    page(ON, []);
    expect(await panel()).toBeTruthy();
    expect(await screen.findByText("No lab spend this month")).toBeInTheDocument();
  });

  it("phone: the panel follows the widget being on", async () => {
    setViewport("phone");
    page(ON);
    const p = await panel();
    expect(await p.findAllByRole("listitem")).toHaveLength(3);
  });
});
