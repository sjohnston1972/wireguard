// Cost as widgets: every panel has a settings cog, every setting changes what
// the page draws, and with nothing saved the page is today's page.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CostResponse, PagePrefs, SettingValue } from "@shared/api";
import { widgetDef } from "@shared/widgets";
import { renderApp } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { costFixture } from "./testData";
import { forecastPill } from "./model";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

/** Saved settings for the Cost widgets (and optionally layout), as the server would hold them. */
const saved = (widgets: Record<string, Record<string, SettingValue>> = {}, layout?: PagePrefs["layout"]): PagePrefs => ({
  widgets: Object.fromEntries(Object.entries(widgets).map(([id, s]) => [id, { v: widgetDef(id)!.version, s }])),
  ...(layout ? { layout } : {}),
});

function page(prefs: PagePrefs = {}, data: CostResponse = costFixture(), url = "/cost") {
  const server = prefsServer({ cost: prefs });
  const utils = renderApp(url, { routes: { "GET /api/v1/cost": data, ...server.routes } });
  return { ...utils, server };
}

const tile = async (name: string) => within(await screen.findByRole("group", { name }));
const region = async (name: string) => within(await screen.findByRole("region", { name }));
const TILES = ["This session", "Month to date (actual)", "Estimated this month", "Monthly budget", "Cost guard"];
const budget = (pct: number, level: "ok" | "warn" | "over"): CostResponse["budget"] => ({ budget: 10, actual: pct / 10, session: 0, total: pct / 10, pct, level, month: "2026-10", alerted: 0 });
const names = (c: HTMLElement) => [...c.querySelectorAll(".cost-split__name")].map((e) => e.textContent);
const manySessions = (n: number): CostResponse["sessions"] =>
  Array.from({ length: n }, (_, i) => ({
    runId: `run-${n - i}`,
    started: new Date(Date.UTC(2026, 9, 2 - i, 9, 0)).toISOString(),
    ended: new Date(Date.UTC(2026, 9, 2 - i, 10, 0)).toISOString(),
    durationSeconds: 3600,
    region: "uksouth",
    vmSize: "Standard_B1s",
    estimatedGbp: 0.01 * (i + 1),
    perHourGbp: 0.0144,
    stillRunning: false,
  }));

describe("Cost widgets: frame and defaults", () => {
  it("cost: every panel is a widget", async () => {
    page();
    for (const title of ["Cost figures", "Spend over time", "Spend breakdown", "Forecast vs budget", "Spend by region", "Cost per session", "Insights", "Sessions"]) {
      expect(await screen.findByRole("button", { name: `${title} settings` })).toBeInTheDocument();
    }
  });

  it("with no prefs cost renders today's tiles, columns, ranges and colours", async () => {
    const { container } = page({}, costFixture({ budget: budget(85, "warn"), projection: { gbp: 12, basis: "x" } }));
    // five tiles, the budget tile amber (85 % is past 80), the guard word from the server
    for (const n of TILES) expect(await tile(n)).toBeTruthy();
    const b = await tile("Monthly budget");
    expect(b.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "85");
    expect(container.querySelector('[aria-label="Monthly budget"] .tile__icon--amber')).not.toBeNull();
    expect(container.querySelector('[aria-label="Cost guard"] .tile__icon--amber')).not.toBeNull();
    expect((await tile("Cost guard")).getByText("Nearly there")).toBeInTheDocument();
    // Amber is never colour alone: the budget tile says its word too (accessibility ruling).
    expect(b.getByText("Nearly there")).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Month to date (actual)"] .tile__delta')).not.toBeNull();
    // spend: forecast, budget pace, legend and note all on; no previous line
    const spend = await region("Spend over time");
    const key = spend.getByRole("list", { name: "Chart key" });
    expect(within(key).getByText("Actual spend")).toBeInTheDocument();
    expect(within(key).getByText("Forecast")).toBeInTheDocument();
    expect(within(key).getByText(/Budget pace/)).toBeInTheDocument();
    expect(within(key).queryByText("Previous period")).not.toBeInTheDocument();
    expect(spend.getByText(/Azure figures lag up to 24 h/)).toBeInTheDocument();
    // breakdown: Azure's split by type, no extra percentages beside the amounts
    const br = await region("Spend breakdown");
    expect(br.getByText("Compute (VM)")).toBeInTheDocument();
    expect(br.getByText("£0.18")).toBeInTheDocument();
    // forecast: the pill is Over budget at 100 % (12 of 10)
    const fc = await region("Forecast vs budget");
    expect(fc.getByText("Over budget")).toBeInTheDocument();
    expect(fc.getByRole("figure", { name: "Month so far against budget" })).toBeInTheDocument();
    // split: by region in the API's order, tracks and percent
    const split = await region("Spend by region");
    expect(names(split.getByRole("list").parentElement as HTMLElement)).toEqual(["UK South (London)", "North Europe (Dublin)"]);
    expect(container.querySelectorAll(".cost-split__track")).toHaveLength(2);
    expect(container.querySelectorAll(".cost-split__pct")).toHaveLength(2);
    // per session: every session in the chart
    expect((await region("Cost per session")).getByRole("figure", { name: "Cost of each session" })).toHaveTextContent("3 days");
    // sessions: all, newest first, the five optional columns and no Ended
    const t = within(await screen.findByRole("table", { name: "Sessions" }));
    expect(t.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Started", "Status", "Region", "VM size", "Duration", "Estimated cost", "Cost / hour", "Details"]);
    const rows = t.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("2 Oct, 09:41");
    expect(container.querySelector(".dt--compact")).toBeNull();
  });

  it("with no prefs the rows keep today's grid: no inline columns and not the generic layout", async () => {
    const { container } = page();
    await screen.findByRole("group", { name: "Monthly budget" });
    expect(container.querySelector(".cost-grid")).not.toHaveClass("cost-grid--generic");
    for (const r of container.querySelectorAll<HTMLElement>(".cost-row")) expect(r.style.gridTemplateColumns).toBe("");
  });
});

describe("Cost widgets: data settings", () => {
  it("kpi tiles", async () => {
    const { container } = page(saved({ "cost.kpis": { tiles: ["month", "budget"] } }));
    await screen.findByRole("group", { name: "Month to date (actual)" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Cost guard" })).not.toBeInTheDocument());
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")).filter((n) => TILES.includes(n!))).toEqual(["Month to date (actual)", "Monthly budget"]);
    expect(container.querySelector(".cost-kpis")).toHaveClass("cost-kpis--custom");
    expect((container.querySelector(".cost-kpis") as HTMLElement).style.getPropertyValue("--cost-kpi-n")).toBe("2");
  });

  it("spend forecast and budget overlays off; previous line on at start and the Compare switch still toggles it", async () => {
    page(saved({ "cost.spend": { forecast: false, budgetLine: false, previous: true } }), costFixture({ projection: { gbp: 12, basis: "x" } }));
    const spend = await region("Spend over time");
    await waitFor(() => expect(within(spend.getByRole("list", { name: "Chart key" })).queryByText("Forecast")).not.toBeInTheDocument());
    const key = within(spend.getByRole("list", { name: "Chart key" }));
    expect(key.queryByText(/Budget pace/)).not.toBeInTheDocument();
    expect(key.getByText("Previous period")).toBeInTheDocument();
    expect(spend.getByRole("figure", { name: "Daily spend" })).not.toHaveTextContent(/forecast|budget/);
    const sw = screen.getByRole("switch", { name: "Compare to previous period" });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    expect(within(spend.getByRole("list", { name: "Chart key" })).queryByText("Previous period")).not.toBeInTheDocument();
    await userEvent.click(sw);
    expect(within(spend.getByRole("list", { name: "Chart key" })).getByText("Previous period")).toBeInTheDocument();
  });

  it("breakdown group by region", async () => {
    page(saved({ "cost.breakdown": { groupBy: "region" } }));
    const br = await region("Spend breakdown");
    await waitFor(() => expect(br.getByText("UK South (London)")).toBeInTheDocument());
    expect(br.queryByText("Compute (VM)")).not.toBeInTheDocument();
    expect(br.getByText("Estimate")).toBeInTheDocument();
  });

  it("split starting view and largest first", async () => {
    const data = costFixture({
      breakdown: {
        ...costFixture().breakdown!,
        byRegion: [
          { location: "northeurope", name: "North Europe (Dublin)", gbp: 0.06, pct: 20 },
          { location: "uksouth", name: "UK South (London)", gbp: 0.24, pct: 80 },
        ],
      },
    });
    const first = page(saved({ "cost.split": { order: "largest" } }), data);
    const split = await region("Spend by region");
    await waitFor(() => expect(names(split.getByRole("list").parentElement as HTMLElement)).toEqual(["UK South (London)", "North Europe (Dublin)"]));
    first.unmount();

    page(saved({ "cost.split": { view: "resource" } }), data);
    const byType = await region("Spend by resource type");
    expect(names(byType.getByRole("list").parentElement as HTMLElement)).toEqual(["Compute (VM)", "Network (egress)", "Disk (managed)"]);
    // the in-panel switch still changes the view for the visit
    await userEvent.click(byType.getByRole("radio", { name: "Region" }));
    expect(await region("Spend by region")).toBeTruthy();
  });

  it("per session last 10", async () => {
    page(saved({ "cost.perSession": { shown: "10" } }), costFixture({ sessions: manySessions(12) }));
    const ps = await region("Cost per session");
    await waitFor(() => expect(ps.getByRole("figure", { name: "Cost of each session" })).toHaveTextContent("10 days"));
    expect(ps.getByText("Total sessions").parentElement).toHaveTextContent("12");
  });

  it("sessions starting status, sort and the Ended column", async () => {
    const { unmount } = page(saved({ "cost.sessions": { status: "ended" } }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("row")).toHaveLength(3));
    expect(screen.getByRole("button", { name: "Ended" })).toHaveAttribute("aria-pressed", "true");
    unmount();

    const second = page(saved({ "cost.sessions": { sort: "duration" } }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("row")[1]).toHaveTextContent("25 Sep, 10:52"));
    second.unmount();

    page(saved({ "cost.sessions": { columns: ["region", "ended"] } }));
    const t = within(await screen.findByRole("table", { name: "Sessions" }));
    await waitFor(() => expect(t.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Started", "Status", "Region", "Ended", "Details"]));
    expect(t.getByText("26 Sep, 13:46")).toBeInTheDocument();
    expect(t.getByText("Still running")).toBeInTheDocument();
  });
});

describe("Cost widgets: thresholds and display", () => {
  it("budget thresholds colour the budget tile only, with a word; the cost guard tile still follows the server", async () => {
    const { container } = page(saved({ "cost.kpis": { budgetUsed: { warn: 50, bad: 80 } } }), costFixture({ budget: budget(85, "warn") }));
    const b = await tile("Monthly budget");
    await waitFor(() => expect(b.getByText("Over budget")).toBeInTheDocument());
    expect(container.querySelector('[aria-label="Monthly budget"] .tile__icon--red')).not.toBeNull();
    const g = await tile("Cost guard");
    expect(g.getByText("Nearly there")).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Cost guard"] .tile__icon--amber')).not.toBeNull();
  });

  it("the Monthly budget tile always says its word when amber or red, thresholds customised or not", async () => {
    const red = page({}, costFixture({ budget: budget(100, "over") }));
    let b = await tile("Monthly budget");
    await waitFor(() => expect(b.getByText("Over budget")).toBeInTheDocument());
    expect(red.container.querySelector('[aria-label="Monthly budget"] .tile__icon--red')).not.toBeNull();
    red.unmount();
    const green = page({}, costFixture({ budget: budget(50, "ok") }));
    b = await tile("Monthly budget");
    expect(green.container.querySelector('[aria-label="Monthly budget"] .tile__icon--green')).not.toBeNull();
    expect(b.queryByText("Nearly there")).not.toBeInTheDocument();
    expect(b.queryByText("Over budget")).not.toBeInTheDocument();
    green.unmount();
    // Bar off: the word stays.
    page(saved({ "cost.kpis": { budgetBar: false } }), costFixture({ budget: budget(85, "warn") }));
    b = await tile("Monthly budget");
    await waitFor(() => expect(b.queryByRole("progressbar")).toBeNull());
    expect(b.getByText("Nearly there")).toBeInTheDocument();
  });

  it("budget threshold just below and at each cutoff", async () => {
    const warnAt = { "cost.kpis": { budgetUsed: { warn: 85, bad: 90 } } };
    const below = page(saved(warnAt), costFixture({ budget: budget(84, "warn") }));
    let b = await tile("Monthly budget");
    await waitFor(() => expect(below.container.querySelector('[aria-label="Monthly budget"] .tile__icon--green')).not.toBeNull());
    expect(b.queryByText("Nearly there")).not.toBeInTheDocument();
    below.unmount();
    const at = page(saved(warnAt), costFixture({ budget: budget(85, "warn") }));
    b = await tile("Monthly budget");
    await waitFor(() => expect(b.getByText("Nearly there")).toBeInTheDocument());
    at.unmount();
    page(saved(warnAt), costFixture({ budget: budget(90, "over") }));
    b = await tile("Monthly budget");
    await waitFor(() => expect(b.getByText("Over budget")).toBeInTheDocument());
  });

  it("kpi change vs previous and budget progress bar off", async () => {
    const { container } = page(saved({ "cost.kpis": { deltas: false, budgetBar: false } }));
    await waitFor(() => expect(container.querySelector('[aria-label="Monthly budget"] [role="progressbar"]')).toBeNull());
    expect(container.querySelector('[aria-label="Month to date (actual)"] .tile__delta')).toBeNull();
  });

  it("forecast warn threshold", async () => {
    // 9.30 of a 10.00 budget is 93 %
    const ok = page({}, costFixture());
    expect((await region("Forecast vs budget")).getByText("On track")).toBeInTheDocument();
    ok.unmount();
    const warn = page(saved({ "cost.forecast": { forecast: { warn: 90, bad: 100 } } }));
    await waitFor(async () => expect((await region("Forecast vs budget")).getByText("Near budget")).toBeInTheDocument());
    warn.unmount();
    // 93 % is under the budget: the bad cutoff turns it red, but it is still Near budget, not Over.
    const bad = page(saved({ "cost.forecast": { forecast: { warn: 90, bad: 93 } } }));
    await waitFor(async () => expect((await region("Forecast vs budget")).getByText("Near budget")).toHaveClass("cost-pill--bad"));
    bad.unmount();
    // exactly on the budget is still on track, as today
    page({}, costFixture({ projection: { gbp: 10, basis: "x" } }));
    expect((await region("Forecast vs budget")).getByText("On track")).toBeInTheDocument();
  });

  it("forecast pill: Over budget / On track follow projection > budget (unrounded); thresholds set only the tone and Near budget", () => {
    const pill = (gbp: number, warn: number | null, bad: number | null) => forecastPill(gbp, 10, { warn, bad });
    // Defaults (bad 100): today's pill.
    expect(pill(9.3, null, 100)).toEqual({ tone: "good", text: "On track" });
    expect(pill(10, null, 100)).toEqual({ tone: "good", text: "On track" });
    expect(pill(12, null, 100)).toEqual({ tone: "bad", text: "Over budget" });
    // 100.004 % is over, though it rounds to 100.00 %.
    expect(pill(10.0004, null, 100)).toEqual({ tone: "bad", text: "Over budget" });
    // Threshold off: still the truth in words, no colour.
    expect(pill(12, null, null)).toEqual({ tone: "plain", text: "Over budget" });
    expect(pill(9.99, null, null)).toEqual({ tone: "good", text: "On track" });
    // bad 150: 120 % is over the budget, not yet red.
    expect(pill(12, null, 150)).toEqual({ tone: "plain", text: "Over budget" });
    expect(pill(12, 110, 150)).toEqual({ tone: "warn", text: "Over budget" });
    expect(pill(15, 110, 150)).toEqual({ tone: "bad", text: "Over budget" });
    // Under the budget the cutoffs give Near budget, never Over.
    expect(pill(9.3, 90, 100)).toEqual({ tone: "warn", text: "Near budget" });
    expect(pill(9.3, 90, 93)).toEqual({ tone: "bad", text: "Near budget" });
    expect(pill(8.9, 90, 93)).toEqual({ tone: "good", text: "On track" });
    // No projection or no budget: no pill.
    expect(forecastPill(null, 10, { warn: null, bad: 100 })).toBeNull();
    expect(forecastPill(5, 0, { warn: null, bad: 100 })).toBeNull();
  });

  it("forecast pill at 100.004 % says Over budget, and with bad 150 at 120 % still says Over budget", async () => {
    const r1 = page({}, costFixture({ projection: { gbp: 10.0004, basis: "x" } }));
    await waitFor(async () => expect((await region("Forecast vs budget")).getByText("Over budget")).toHaveClass("cost-pill--bad"));
    r1.unmount();
    page(saved({ "cost.forecast": { forecast: { warn: null, bad: 150 } } }), costFixture({ projection: { gbp: 12, basis: "x" } }));
    await waitFor(async () => expect((await region("Forecast vs budget")).getByText("Over budget")).toHaveClass("cost-pill--plain"));
  });

  it("forecast month-so-far chart off", async () => {
    page(saved({ "cost.forecast": { chart: false } }));
    const fc = await region("Forecast vs budget");
    await waitFor(() => expect(fc.queryByRole("figure")).not.toBeInTheDocument());
    expect(fc.getByText("Forecast")).toBeInTheDocument();
  });

  it("per-session threshold colours bars", async () => {
    const dear = costFixture().sessions.map((s, i) => ({ ...s, estimatedGbp: [2.5, 0.2, 0.7][i]! }));
    const { container } = page(saved({ "cost.perSession": { session: { warn: 0.5, bad: 2 } } }), costFixture({ sessions: dear }));
    const ps = await region("Cost per session");
    await waitFor(() => expect(ps.getByText(/over £2\.00/)).toBeInTheDocument());
    // oldest first: run-1 £0.70 amber, run-2 £0.20 untouched, run-3 £2.50 red
    const fills = [...container.querySelectorAll('[aria-label="Cost of each session"] rect')].map((r) => r.getAttribute("fill"));
    expect(fills).toEqual(["var(--amber)", "var(--blue)", "var(--red)"]);
    expect(ps.getByText("Amber: 1 session over £0.50")).toBeInTheDocument();
    expect(ps.getByText("Red: 1 session over £2.00")).toBeInTheDocument();
  });

  it("per-session bars are untouched with the threshold off", async () => {
    const { container } = page();
    await region("Cost per session");
    const fills = [...container.querySelectorAll('[aria-label="Cost of each session"] rect')].map((r) => r.getAttribute("fill"));
    expect(fills).toEqual(["var(--blue)", "var(--blue)", "var(--blue)"]);
    expect(container.querySelector(".cost-flag--sessions")).toBeNull();
  });

  it("breakdown percentages: on by default (today's share column), off hides the column", async () => {
    const { container, unmount } = page();
    await region("Spend breakdown");
    const legend = () => container.querySelector(".cost-breakdown .donut__legend")!;
    await waitFor(() => expect([...legend().querySelectorAll(".donut__pct")].map((x) => x.textContent)).toEqual(["60%", "23%", "17%"]));
    expect([...legend().querySelectorAll(".donut__val")].map((x) => x.textContent)).toEqual(["£0.18", "£0.070", "£0.050"]);
    unmount();
    const off = page(saved({ "cost.breakdown": { percentages: false } }));
    const br = await region("Spend breakdown");
    await waitFor(() => expect(off.container.querySelector(".cost-breakdown .donut__pct")).toBeNull());
    expect(br.getByText("£0.18")).toBeInTheDocument();
    expect(br.queryByText(/\(60%\)/)).toBeNull();
  });

  it("split track bars and percent off", async () => {
    const { container } = page(saved({ "cost.split": { tracks: false, percent: false } }));
    await region("Spend by region");
    await waitFor(() => expect(container.querySelectorAll(".cost-split__track")).toHaveLength(0));
    expect(container.querySelectorAll(".cost-split__pct")).toHaveLength(0);
    expect(container.querySelectorAll(".cost-split__gbp")).toHaveLength(2);
  });

  it("spend note and legend off", async () => {
    page(saved({ "cost.spend": { note: false, legend: false } }));
    const spend = await region("Spend over time");
    await waitFor(() => expect(spend.queryByRole("list", { name: "Chart key" })).not.toBeInTheDocument());
    expect(spend.queryByText(/Azure figures lag/)).not.toBeInTheDocument();
    expect(spend.getByRole("figure", { name: "Daily spend" })).toBeInTheDocument();
  });

  it("sessions compact density", async () => {
    const { container } = page(saved({ "cost.sessions": { density: "compact" } }));
    await waitFor(() => expect(container.querySelector(".cost-sessions .dt--compact")).not.toBeNull());
  });

  it("a setting changed in the cog shows at once", async () => {
    page();
    const spend = await region("Spend over time");
    await userEvent.click(await screen.findByRole("button", { name: "Spend over time settings" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Legend" }));
    await waitFor(() => expect(spend.queryByRole("list", { name: "Chart key" })).not.toBeInTheDocument());
  });
});

describe("Cost widgets: layout", () => {
  it("hiding Spend over time removes the header's Compare to previous period switch (it would do nothing)", async () => {
    const shown = page();
    await region("Spend over time");
    expect(screen.getByRole("switch", { name: "Compare to previous period" })).toBeInTheDocument();
    shown.unmount();
    page(saved({}, { hidden: ["cost.spend"] }));
    await region("Spend breakdown");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Spend over time" })).not.toBeInTheDocument());
    expect(screen.queryByRole("switch", { name: "Compare to previous period" })).not.toBeInTheDocument();
    expect(screen.queryByText("Compare to previous period")).not.toBeInTheDocument();
  });

  it("hiding forecast widens spend and breakdown", async () => {
    const { container } = page(saved({}, { hidden: ["cost.forecast"] }));
    await region("Spend over time");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Forecast vs budget" })).not.toBeInTheDocument());
    expect(container.querySelector<HTMLElement>(".cost-row--r2")!.style.gridTemplateColumns).toBe("minmax(0, 5fr) minmax(0, 4fr)");
    expect(container.querySelector(".cost-grid")).toHaveClass("cost-grid--generic");
  });

  it("hiding insights widens split and per session", async () => {
    const { container } = page(saved({}, { hidden: ["cost.insights"] }));
    await region("Spend over time");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Insights" })).not.toBeInTheDocument());
    expect(container.querySelector<HTMLElement>(".cost-row--r3")!.style.gridTemplateColumns).toBe("minmax(0, 4fr) minmax(0, 4fr)");
  });

  it("the reordered layout renders in the saved order", async () => {
    const { container } = page(saved({}, { order: { r2: ["cost.breakdown", "cost.spend", "cost.forecast"] } }));
    await region("Spend over time");
    await waitFor(() => {
      const heads = [...container.querySelectorAll(".cost-row--r2 .panel__title")].map((h) => h.textContent);
      expect(heads).toEqual(["Spend breakdown", "Spend over time", "Forecast vs budget"]);
    });
    expect(container.querySelector<HTMLElement>(".cost-row--r2")!.style.gridTemplateColumns).toBe("minmax(0, 4fr) minmax(0, 5fr) minmax(0, 3fr)");
  });

  it("a row with nothing visible is not rendered, and the sessions can go", async () => {
    const { container } = page(saved({}, { hidden: ["cost.sessions", "cost.split", "cost.perSession", "cost.insights"] }));
    await region("Spend over time");
    await waitFor(() => expect(screen.queryByRole("table", { name: "Sessions" })).not.toBeInTheDocument());
    expect(container.querySelector(".cost-row--r3")).toBeNull();
    expect(container.querySelector(".cost-row--r4")).toBeNull();
    expect(container.querySelector(".cost-row--r2")).not.toBeNull();
  });

  it("the short-window named layout is used while rows are default and the generic rows once they change", async () => {
    const first = page();
    await screen.findByRole("group", { name: "Monthly budget" });
    // default: the named areas address the panels directly (rows are display: contents)
    expect(first.container.querySelector(".cost-grid")).not.toHaveClass("cost-grid--generic");
    for (const r of first.container.querySelectorAll(".cost-row")) expect(r).toHaveClass("cost-row--default");
    first.unmount();
    const second = page(saved({}, { order: { r3: ["cost.insights", "cost.split", "cost.perSession"] } }));
    await waitFor(() => expect(second.container.querySelector(".cost-grid")).toHaveClass("cost-grid--generic"));
    // once one row changes, every row is a real row with its own columns
    for (const r of second.container.querySelectorAll<HTMLElement>(".cost-row")) {
      expect(r).not.toHaveClass("cost-row--default");
      expect(r.style.gridTemplateColumns).not.toBe("");
    }
  });
});

describe("Cost widgets: phone", () => {
  it("phone: hidden spend, breakdown or sessions remove their button; hidden insights is not shown inline; kpis tiles apply", async () => {
    setViewport("phone");
    const first = page();
    await screen.findByRole("group", { name: "Monthly budget" });
    for (const n of ["Spend over time", "Breakdown", "Sessions"]) expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Insights" })).toBeInTheDocument();
    first.unmount();

    page(saved({ "cost.kpis": { tiles: ["session", "budget"] } }, { hidden: ["cost.spend", "cost.breakdown", "cost.sessions", "cost.insights"] }));
    await screen.findByRole("group", { name: "Monthly budget" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sessions" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Spend over time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Breakdown" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Insights" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Cost guard" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Monthly budget" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "This session" })).toBeInTheDocument();
  });

  it("phone: settings apply to the sheet content", async () => {
    setViewport("phone");
    page(saved({ "cost.sessions": { columns: ["ended"] }, "cost.spend": { legend: false } }));
    await screen.findByRole("group", { name: "Monthly budget" });
    await act(async () => {});
    await userEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    const sheet = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(sheet.getByRole("columnheader", { name: "Ended" })).toBeInTheDocument());
    expect(sheet.queryByRole("columnheader", { name: "Region" })).not.toBeInTheDocument();
  });
});
