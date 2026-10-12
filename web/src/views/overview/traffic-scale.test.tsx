// traffic-scale.test.tsx
//
// Plain English: the Network traffic chart picks a unit that shows the
// traffic there is. A tunnel with only WireGuard's keepalives moves a few
// bytes a second: that must read "5 B/s", not a flat "0 KB/s" (Steven,
// 2026-10-12: "network traffic on the dash shows nothing"). The chart also
// fits its box: the legend row plus the plot never run past the panel, so
// the time labels under the plot are not cut off.
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { NOW_MS, overview, prefsRoutes, saved } from "./testData";

const iso = (ms: number) => new Date(ms).toISOString();
const hist = (rx: number[], tx: number[]) => rx.map((v, i) => ({ t: iso(NOW_MS - (rx.length - i) * 30_000), rx: v, tx: tx[i] }));
const summary = async () => within(await screen.findByRole("region", { name: "Network traffic" })).findByTestId("chart-summary");

describe("Network traffic units", () => {
  it("keepalive-only traffic reads in bytes per second, not a flat 0 KB/s", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([0, 6, 7, 4], [0, 7, 8, 5]) } }), {}) });
    await waitFor(async () => expect(await summary()).toHaveTextContent("In: latest 4 B/s, peak 7 B/s. Out: latest 5 B/s, peak 8 B/s."));
  });

  it("KB/s once a line passes 1 KB/s, MB/s past 1 MB/s", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([512, 3072], [100, 200]) } }), {}) });
    await waitFor(async () => expect(await summary()).toHaveTextContent("In: latest 3 KB/s, peak 3 KB/s. Out: latest 0.2 KB/s"));
  });

  it("MB/s for fast traffic", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([1_048_576, 2_621_440], [0, 0]) } }), {}) });
    await waitFor(async () => expect(await summary()).toHaveTextContent("In: latest 2.5 MB/s, peak 2.5 MB/s"));
  });

  it("bits: bit/s and kbit/s below a megabit", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([0, 5], [0, 5]) } }), saved("overview.traffic", { units: "mbps" })) });
    await waitFor(async () => expect(await summary()).toHaveTextContent("In: latest 40 bit/s"));
  });

  it("bits: kbit/s between a kilobit and a megabit", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([0, 2_500], [0, 0]) } }), saved("overview.traffic", { units: "mbps" })) });
    await waitFor(async () => expect(await summary()).toHaveTextContent("In: latest 20 kbit/s"));
  });
});

describe("Network traffic fits its panel", () => {
  it("the legend row and the plot together fit the measured box (the time labels are inside it)", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist([0, 6, 7, 4], [0, 7, 8, 5]) } }), {}) });
    const t = await screen.findByRole("region", { name: "Network traffic" });
    const plot = await waitFor(() => {
      const p = t.querySelector<HTMLElement>(".tsc__plot");
      if (!p) throw new Error("no plot yet");
      return p;
    });
    // jsdom measures nothing, so the box is useElementHeight's 140 px fallback; the legend row takes 22 px of it.
    expect(parseInt(plot.style.height, 10)).toBeLessThanOrEqual(140 - 22);
  });
});
