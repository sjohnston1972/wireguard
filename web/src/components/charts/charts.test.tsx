import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// uPlot needs canvas and matchMedia, which jsdom does not have. The component
// logic (summary, empty state, lifecycle) is what is under test here.
const created: Array<{ opts: unknown; data: unknown; destroyed: boolean }> = [];
vi.mock("uplot", () => ({
  default: class FakeUPlot {
    rec: { opts: unknown; data: unknown; destroyed: boolean };
    constructor(opts: unknown, data: unknown) {
      this.rec = { opts, data, destroyed: false };
      created.push(this.rec);
    }
    setSize() {}
    setData(d: unknown) {
      this.rec.data = d;
    }
    destroy() {
      this.rec.destroyed = true;
    }
    static paths = { bars: () => () => null, spline: () => () => null };
  },
}));

import { Sparkline } from "./Sparkline";
import { Ring } from "./Ring";
import { Donut } from "./Donut";
import { ProgressBar } from "./ProgressBar";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { BarChart } from "./BarChart";
import { StackedBars } from "./StackedBars";
import { axisTicks } from "./axis";

describe("ProgressBar", () => {
  it("exposes value and name", () => {
    render(<ProgressBar value={42} label="Budget used" />);
    const bar = screen.getByRole("progressbar", { name: "Budget used" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
  it("clamps out-of-range values", () => {
    render(<ProgressBar value={140} label="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
  it("renders 'no data' for a missing value, not 0", () => {
    render(<ProgressBar value={null} label="x" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  it("has an accessible summary with range and latest value", () => {
    render(<Sparkline label="Latency" data={[10, 30, 20, 25]} unit=" ms" />);
    const img = screen.getByRole("img", { name: /Latency/ });
    expect(img).toHaveAccessibleName(/4 points/);
    expect(img).toHaveAccessibleName(/min 10 ms/);
    expect(img).toHaveAccessibleName(/max 30 ms/);
    expect(img).toHaveAccessibleName(/latest 25 ms/);
  });
  it("renders 'no data' for empty or all-null data", () => {
    const { rerender } = render(<Sparkline label="Latency" data={[]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
    rerender(<Sparkline label="Latency" data={[null, null]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("tolerates gaps (null) in the series", () => {
    render(<Sparkline label="Latency" data={[1, null, 3]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/2 points/);
  });
  it('variant="bars" draws one bar per known value and leaves a gap for null (no data, not 0)', () => {
    const hourly = [3, 0, null, null, 5, 2];
    const { container } = render(<Sparkline variant="bars" label="Hits (24h)" data={hourly} />);
    const img = screen.getByRole("img", { name: /Hits \(24h\)/ });
    expect(img).toHaveAccessibleName(/4 points/);
    expect(img).toHaveAccessibleName(/2 hours? with no data/);
    const bars = container.querySelectorAll("[data-bar]");
    expect(bars).toHaveLength(4);
    expect([...bars].map((b) => b.getAttribute("data-bar"))).toEqual(["0", "1", "4", "5"]);
    expect(container.querySelector("path")).toBeNull();
  });
  it('variant="bars" with only one known hour draws a baseline and no lone bar, and says so', () => {
    const hourly = [...Array(23).fill(null), 7];
    const { container } = render(<Sparkline variant="bars" label="Drops per hour" data={hourly} />);
    const img = screen.getByRole("img", { name: /Drops per hour/ });
    expect(img).toHaveAccessibleName(/only 1 hour with data/);
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(0);
    expect(container.querySelector("[data-baseline]")).not.toBeNull();
  });
  it('variant="bars" says "no data" when every hour is null', () => {
    render(<Sparkline variant="bars" label="Recent drops" data={[null, null, null]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("Ring", () => {
  it("is an image with its percentage in the name and centre", () => {
    render(<Ring value={67} label="Availability" centre="100%" />);
    expect(screen.getByRole("img", { name: "Availability: 67%" })).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
  it("renders 'no data' when missing", () => {
    render(<Ring value={null} label="Availability" />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
});

describe("Donut", () => {
  const segments = [
    { label: "Compute", value: 62, color: "blue" as const },
    { label: "Network", value: 23, color: "purple" as const },
    { label: "Disk", value: 15, color: "green" as const },
  ];
  it("summarises every segment with its share", () => {
    render(<Donut title="Session cost breakdown" segments={segments} centre={{ value: "£0.13", label: "Total (30 days)" }} />);
    const img = screen.getByRole("img", { name: /Session cost breakdown/ });
    expect(img).toHaveAccessibleName(/Compute 62%/);
    expect(img).toHaveAccessibleName(/Network 23%/);
    expect(img).toHaveAccessibleName(/Disk 15%/);
    expect(screen.getByText("£0.13")).toBeInTheDocument();
  });
  it("renders 'no data' when there is nothing to show", () => {
    render(<Donut title="Breakdown" segments={[{ label: "A", value: 0, color: "blue" }]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
});

const T0 = 1_760_000_000;
describe("TimeSeriesChart", () => {
  const x = [T0, T0 + 60, T0 + 120, T0 + 180];
  it("is a figure with a name and a text summary of each series", () => {
    render(
      <TimeSeriesChart
        title="Network traffic"
        range="1h"
        x={x}
        series={[
          { label: "In", color: "blue", data: [100, 400, 200, 300] },
          { label: "Out", color: "purple", data: [10, 40, 20, 30] },
        ]}
        unit=" KB/s"
      />,
    );
    expect(screen.getByRole("figure", { name: "Network traffic" })).toBeInTheDocument();
    const summary = screen.getByTestId("chart-summary");
    expect(summary).toHaveTextContent("In: latest 300 KB/s, peak 400 KB/s");
    expect(summary).toHaveTextContent("Out: latest 30 KB/s, peak 40 KB/s");
    expect(summary).toHaveTextContent("last 1 hour");
  });
  it("renders 'no data' and no plot when there are no points", () => {
    const before = created.length;
    render(<TimeSeriesChart title="Network traffic" range="1h" x={[]} series={[{ label: "In", color: "blue", data: [] }]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
    expect(created.length).toBe(before);
  });
  it("creates the plot and destroys it on unmount", () => {
    const before = created.length;
    const { unmount } = render(
      <TimeSeriesChart title="t" range="24h" x={x} series={[{ label: "In", color: "blue", data: [1, 2, 3, 4] }]} />,
    );
    expect(created.length).toBe(before + 1);
    unmount();
    expect(created[created.length - 1].destroyed).toBe(true);
  });
  it("new data of the same shape goes to setData on the existing plot (no destroy and re-create, so hover survives)", () => {
    const before = created.length;
    // Fresh arrays and an inline formatter on every render, as a polling view would pass.
    const { rerender } = render(
      <TimeSeriesChart title="t" range="1h" x={[...x]} series={[{ label: "In", color: "blue", data: [1, 2, 3, 4] }, { label: "Out", color: "purple", data: [4, 3, 2, 1] }]} format={(v) => `${v} KB/s`} />,
    );
    expect(created.length).toBe(before + 1);
    const plot = created[created.length - 1];
    const x2 = [T0 + 60, T0 + 120, T0 + 180, T0 + 240];
    rerender(
      <TimeSeriesChart title="t" range="1h" x={x2} series={[{ label: "In", color: "blue", data: [2, 3, 4, 5] }, { label: "Out", color: "purple", data: [5, 4, 3, 2] }]} format={(v) => `${v} KB/s`} />,
    );
    expect(created.length).toBe(before + 1);
    expect(plot.destroyed).toBe(false);
    expect(plot.data).toEqual([x2, [2, 3, 4, 5], [5, 4, 3, 2]]);
  });
  it("re-creates the plot when the series change (count or labels)", () => {
    const before = created.length;
    const { rerender } = render(<TimeSeriesChart title="t" range="1h" x={x} series={[{ label: "In", color: "blue", data: [1, 2, 3, 4] }]} />);
    const first = created[created.length - 1];
    rerender(<TimeSeriesChart title="t" range="1h" x={x} series={[{ label: "In", color: "blue", data: [1, 2, 3, 4] }, { label: "Out", color: "purple", data: [1, 1, 1, 1] }]} />);
    expect(created.length).toBe(before + 2);
    expect(first.destroyed).toBe(true);
    rerender(<TimeSeriesChart title="t" range="1h" x={x} series={[{ label: "Latency", color: "blue", data: [1, 2, 3, 4] }, { label: "Out", color: "purple", data: [1, 1, 1, 1] }]} />);
    expect(created.length).toBe(before + 3);
  });
});

describe("BarChart", () => {
  it("summarises total, peak, budget and forecast", () => {
    render(
      <BarChart
        title="Spend over time"
        bars={[
          { label: "3 Sept", value: 0.02 },
          { label: "4 Sept", value: 0.05 },
        ]}
        forecast={[
          { label: "5 Sept", value: 0.04 },
          { label: "6 Sept", value: 0.04 },
        ]}
        budget={0.2}
        format={(v) => `£${v.toFixed(2)}`}
      />,
    );
    const fig = screen.getByRole("figure", { name: "Spend over time" });
    expect(fig).toHaveTextContent("2 days");
    expect(fig).toHaveTextContent("total £0.07");
    expect(fig).toHaveTextContent("peak £0.05 on 4 Sept");
    expect(fig).toHaveTextContent("budget £0.20");
    expect(fig).toHaveTextContent("forecast");
  });
  it("renders 'no data' with no bars", () => {
    render(<BarChart title="Spend" bars={[]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
  it("draws a null day as a gap but keeps the day on the axis, and leaves it out of the totals", () => {
    const { container } = render(
      <BarChart
        title="Spend over time"
        bars={[
          { label: "1 Oct", value: 0.02 },
          { label: "2 Oct", value: null },
          { label: "3 Oct", value: 0.05 },
        ]}
        format={(v) => `£${v.toFixed(2)}`}
      />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    expect([...container.querySelectorAll("text")].map((t) => t.textContent)).toContain("2 Oct");
    const fig = screen.getByRole("figure", { name: "Spend over time" });
    expect(fig).toHaveTextContent("3 days");
    expect(fig).toHaveTextContent("total £0.07");
    expect(fig).toHaveTextContent("1 day with no data");
    expect(fig).toHaveTextContent("peak £0.05 on 3 Oct");
  });
  it("renders 'no data' when every day is null", () => {
    render(<BarChart title="Spend" bars={[{ label: "1 Oct", value: null }]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
});

describe("axisTicks", () => {
  it("puts one tick at the start of each run of equal labels, then thins evenly", () => {
    expect(axisTicks(["a", "a", "b", "b", "c", "c"], 10)).toEqual([0, 2, 4]);
    expect(axisTicks(["1", "2", "3", "4", "5", "6", "7", "8"], 4)).toEqual([0, 2, 4, 6]);
    expect(axisTicks(["a", "a", "a", "b", "b", "b", "c", "c", "c", "d"], 2)).toEqual([0, 6]);
    expect(axisTicks([], 4)).toEqual([]);
  });
  it("never repeats a label", () => {
    const labels = Array.from({ length: 96 }, (_, i) => `${1 + Math.floor(i / 24)} Oct`);
    for (const max of [2, 3, 5, 8, 20]) {
      const picked = axisTicks(labels, max).map((i) => labels[i]);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.length).toBeLessThanOrEqual(max);
    }
  });
});

describe("StackedBars", () => {
  const series = [
    { key: "ok", label: "Successful runs", color: "green" as const },
    { key: "bad", label: "Failed runs", color: "red" as const },
  ];
  const buckets = [
    { label: "19 Sept", values: { ok: 4, bad: 0 } },
    { label: "20 Sept", values: { ok: 6, bad: 1 } },
    { label: "21 Sept", values: { ok: 2, bad: 3 } },
    { label: "22 Sept", values: { ok: 0, bad: 0 } },
  ];
  it("summarises the buckets and the series", () => {
    render(<StackedBars title="Activity timeline" series={series} buckets={buckets} />);
    const fig = screen.getByRole("figure", { name: "Activity timeline" });
    expect(fig).toHaveTextContent("4 buckets");
    expect(fig).toHaveTextContent("Successful runs 12");
    expect(fig).toHaveTextContent("Failed runs 4");
    expect(fig).toHaveTextContent("busiest 20 Sept");
  });
  it("labels each day once on the axis when several buckets share a day (no '19 Sept 19 Sept')", () => {
    const hourly = Array.from({ length: 30 }, (_, i) => ({ label: `${19 + Math.floor(i / 6)} Sept`, values: { ok: 1 + (i % 3), bad: 0 } }));
    const { container } = render(<StackedBars title="Activity timeline" series={series} buckets={hourly} />);
    const ticks = [...container.querySelectorAll("text.stack__tick")].map((t) => t.textContent ?? "").filter((t) => /Sept/.test(t));
    expect(ticks.length).toBeGreaterThan(1);
    expect(new Set(ticks).size).toBe(ticks.length);
    // Each label sits at the first bucket of its day.
    expect(ticks[0]).toBe("19 Sept");
  });
  it("renders 'no data' with no buckets", () => {
    render(<StackedBars title="Activity timeline" series={series} buckets={[]} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
  it("shows a tooltip for the active bucket by keyboard", async () => {
    render(<StackedBars title="Activity timeline" series={series} buckets={buckets} />);
    const plot = screen.getByRole("application", { name: /Activity timeline/ });
    plot.focus();
    await userEvent.keyboard("{ArrowRight}");
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("20 Sept");
    expect(tip).toHaveTextContent("6 Successful runs");
    expect(tip).toHaveTextContent("1 Failed runs");
  });
  it("brush selection by keyboard: Shift+arrows extend, Enter commits", async () => {
    const onBrush = vi.fn();
    render(<StackedBars title="Activity timeline" series={series} buckets={buckets} onBrush={onBrush} />);
    const plot = screen.getByRole("application", { name: /Activity timeline/ });
    plot.focus();
    await userEvent.keyboard("{ArrowRight}"); // active = 1
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}"); // select 1..3
    await userEvent.keyboard("{Enter}");
    expect(onBrush).toHaveBeenCalledWith({ from: 1, to: 3 });
  });
  it("brush selection by pointer drag", () => {
    const onBrush = vi.fn();
    render(<StackedBars title="Activity timeline" series={series} buckets={buckets} onBrush={onBrush} />);
    const plot = screen.getByRole("application", { name: /Activity timeline/ });
    plot.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 100, right: 400, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(plot, { clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(plot, { clientX: 310, pointerId: 1 });
    fireEvent.pointerUp(plot, { clientX: 310, pointerId: 1 });
    expect(onBrush).toHaveBeenCalledWith({ from: 1, to: 3 });
  });
  it("a plain click does not brush", () => {
    const onBrush = vi.fn();
    render(<StackedBars title="Activity timeline" series={series} buckets={buckets} onBrush={onBrush} />);
    const plot = screen.getByRole("application", { name: /Activity timeline/ });
    plot.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 100, right: 400, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(plot, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(plot, { clientX: 120, pointerId: 1 });
    expect(onBrush).not.toHaveBeenCalled();
  });
});
