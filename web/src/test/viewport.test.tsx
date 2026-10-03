import { describe, expect, it } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { TimeSeriesChart, useIsPhone } from "@/components";
import { setViewport } from "./viewport";

describe("the test browser", () => {
  it("without setViewport is a dark desktop", () => {
    expect(window.matchMedia("(max-width: 640px)").matches).toBe(false);
    expect(window.matchMedia("(min-width: 1100px)").matches).toBe(true);
    expect(window.matchMedia("(prefers-color-scheme: light)").matches).toBe(false);
  });

  it("renders charts from @/components (uPlot is faked for every test: jsdom has no canvas)", () => {
    render(<TimeSeriesChart title="Traffic" x={[1, 2, 3]} series={[{ label: "In", color: "blue", data: [1, 5, 3] }]} range="1h" />);
    expect(screen.getByText(/In: latest 3, peak 5/)).toBeInTheDocument();
  });
});

describe("setViewport", () => {
  it("answers width media queries for the chosen size", () => {
    setViewport("phone");
    expect(window.matchMedia("(max-width: 640px)").matches).toBe(true);
    expect(window.matchMedia("(min-width: 1100px)").matches).toBe(false);
    expect(window.innerWidth).toBe(390);
    setViewport("tablet");
    expect(window.matchMedia("(max-width: 640px)").matches).toBe(false);
    expect(window.matchMedia("(min-width: 641px) and (max-width: 1099px)").matches).toBe(true);
    setViewport("desktop");
    expect(window.matchMedia("(min-width: 1100px)").matches).toBe(true);
    expect(window.innerWidth).toBe(1600);
  });

  it("tells listeners when a query's answer changes, and only then", () => {
    setViewport("desktop");
    const seen: boolean[] = [];
    const mq = window.matchMedia("(max-width: 640px)");
    mq.addEventListener("change", (e) => seen.push(e.matches));
    setViewport("tablet");
    setViewport("phone");
    setViewport("desktop");
    expect(seen).toEqual([true, false]);
  });
});

describe("useIsPhone", () => {
  it("is false without matchMedia", () => {
    const saved = window.matchMedia;
    // jsdom has no matchMedia; make sure of it for this test.
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    try {
      expect(renderHook(() => useIsPhone()).result.current).toBe(false);
    } finally {
      window.matchMedia = saved;
    }
  });

  it("is true at 640 px and below, false above, and follows a resize while mounted", () => {
    setViewport(640);
    function Probe() {
      return <output aria-label="phone">{String(useIsPhone())}</output>;
    }
    render(<Probe />);
    expect(screen.getByLabelText("phone")).toHaveTextContent("true");
    act(() => setViewport(641));
    expect(screen.getByLabelText("phone")).toHaveTextContent("false");
    act(() => setViewport("phone"));
    expect(screen.getByLabelText("phone")).toHaveTextContent("true");
  });
});
