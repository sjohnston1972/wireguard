// settings.test.tsx
//
// Plain English: each Overview widget setting changes what the widget shows
// or fetches. Data settings pick what is read and how much; thresholds
// colour this dashboard only, always with a word; display settings take
// parts away. Saved settings come from a working fake of the prefs API.
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { NOW_MS, activityOf, cost, costSessionsOf, notesOf, overview, prefsRoutes, saved, session, speedtestsOf, vmHistory } from "./testData";

const iso = (ms: number) => new Date(ms).toISOString();
const region = (name: string) => screen.findByRole("region", { name });
const KM = "overview.keyMetrics";
const hit = (r: ReturnType<typeof renderApp>, part: string) => r.fetchMock!.calls.some((c) => c.url.includes(part));
const tileNames = (m: HTMLElement) => Array.from(m.querySelectorAll(".ov-tiles__row")).map((x) => Array.from(x.querySelectorAll(".ov-tile")).map((t) => t.getAttribute("aria-label")));
const ringStroke = (tile: HTMLElement) => tile.querySelectorAll("circle")[1]?.getAttribute("stroke");
/** A /history answer whose availability is `pct` (and dns_up points averaging `dns`, when given). */
const history = (pct: number | null, dns?: number) => ({ url }: { url: string }) =>
  vmHistory((new URL(url, "http://x").searchParams.get("range") ?? "1h") as "1h", {
    availability: { expected: 100, received: pct ?? 0, pct },
    points: dns === undefined ? [] : [0, 1].map((i) => ({ t: iso(NOW_MS - (2 - i) * 3_600_000), expected: 60, received: 60, load1: 0.1, rx_rate: 100, tx_rate: 50, rx_rate_max: 200, tx_rate_max: 80, peers_online: 1, dns_up: dns })),
  });

describe("Overview widget settings: data", () => {
  it("key metrics starting range fetches that history range", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { range: "24h" })) });
    const m = await region("Key metrics");
    await waitFor(() => expect(within(m).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(hit(r, "/history?scope=vm&range=24h")).toBe(true));
    // The switch still changes the view for the visit, without saving.
    await user.click(within(m).getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(hit(r, "/history?scope=vm&range=7d")).toBe(true));
    expect(r.fetchMock!.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("tiles setting removes a tile and the rest flow into two rows", async () => {
    const r = renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { tiles: ["endpoint", "clients", "dns", "heartbeat", "sessionCost", "availability"] })) });
    let m = await region("Key metrics");
    await waitFor(() => expect(tileNames(m)).toEqual([["Public endpoint", "Connected clients", "DNS status"], ["Heartbeat (VM)", "Session cost", "Availability"]]));
    expect(Array.from(m.querySelectorAll(".ov-tiles__row")).map((x) => x.className)).toEqual(["ov-tiles__row ov-tiles__row--3", "ov-tiles__row ov-tiles__row--3"]);
    r.unmount();

    const r2 = renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { tiles: ["latency", "dns", "availability"] })) });
    m = await region("Key metrics");
    await waitFor(() => expect(tileNames(m)).toEqual([["Latency (avg)"], ["DNS status", "Availability"]]));
    expect(Array.from(m.querySelectorAll(".ov-tiles__row")).map((x) => x.className)).toEqual(["ov-tiles__row ov-tiles__row--1", "ov-tiles__row ov-tiles__row--2"]);
    r2.unmount();

    renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { tiles: ["heartbeat"] })) });
    m = await region("Key metrics");
    await waitFor(() => expect(tileNames(m)).toEqual([["Heartbeat (VM)"]]));
  });

  it("traffic 24h reads vm history rx_rate and tx_rate", async () => {
    const points = [0, 1, 2].map((i) => ({ t: iso(NOW_MS - (3 - i) * 3_600_000), expected: 60, received: 60, load1: 0.1, rx_rate: 2048 * (i + 1), tx_rate: 1024 * (i + 1), rx_rate_max: 10240 * (i + 1), tx_rate_max: 5120 * (i + 1), peers_online: 1, dns_up: 1 }));
    const r = renderApp("/", {
      routes: prefsRoutes(overview("running"), saved("overview.traffic", { window: "24h" }), {
        "GET /api/v1/history": ({ url }: { url: string }) => {
          const range = new URL(url, "http://x").searchParams.get("range") as "24h";
          return vmHistory(range, range === "24h" ? { points } : {});
        },
      }),
    });
    const t = await region("Network traffic");
    await waitFor(() => expect(within(t).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(hit(r, "/history?scope=vm&range=24h")).toBe(true));
    const summary = await within(t).findByTestId("chart-summary");
    expect(summary).toHaveTextContent("In: latest 6 KB/s, peak 6 KB/s. Out: latest 3 KB/s, peak 3 KB/s. Covers the last 24 hours.");
    // No peak line unless asked for.
    expect(summary).not.toHaveTextContent("In peak");
  });

  it("traffic peak line reads rx_rate_max and tx_rate_max (24h and 7d only)", async () => {
    const points = [0, 1].map((i) => ({ t: iso(NOW_MS - (2 - i) * 3_600_000), expected: 60, received: 60, load1: 0.1, rx_rate: 1024, tx_rate: 1024, rx_rate_max: 10240, tx_rate_max: 5120, peers_online: 1, dns_up: 1 }));
    const user = userEvent.setup();
    renderApp("/", {
      routes: prefsRoutes(overview("running"), saved("overview.traffic", { window: "7d", peak: true }), {
        "GET /api/v1/history": ({ url }: { url: string }) => vmHistory(new URL(url, "http://x").searchParams.get("range") as "7d", { points }),
      }),
    });
    const t = await region("Network traffic");
    await waitFor(() => expect(within(t).getByTestId("chart-summary")).toHaveTextContent("In peak: latest 10 KB/s"));
    expect(within(t).getByTestId("chart-summary")).toHaveTextContent("Out peak: latest 5 KB/s");
    // A session window has no history, so no peak line.
    await user.click(within(t).getByRole("radio", { name: "Session" }));
    await waitFor(() => expect(within(t).getByTestId("chart-summary")).not.toHaveTextContent("peak:"));
  });

  it("traffic Mbit/s converts, and series picks the lines", async () => {
    const hist = [0, 1, 2, 3, 4, 5].map((i) => ({ t: iso(NOW_MS - (6 - i) * 60_000), rx: 125_000 * i, tx: 62_500 * i }));
    renderApp("/", { routes: prefsRoutes(overview("running", { snapshot: { traffic_hist: hist } }), saved("overview.traffic", { units: "mbps", series: ["out"] })) });
    const t = await region("Network traffic");
    await waitFor(() => expect(within(t).getByTestId("chart-summary")).toHaveTextContent("Out: latest 2.5 Mbit/s, peak 2.5 Mbit/s"));
    expect(within(t).getByTestId("chart-summary")).not.toHaveTextContent("In:");
  });

  it("events rows, range and types filter the list and the activity query range", async () => {
    const r = renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.events", { rows: 3, range: "7d", types: ["deploy", "config"] }), { "GET /api/v1/activity": activityOf(8) }) });
    const ev = await region("Recent events");
    await waitFor(() => expect(hit(r, "/activity?range=7d")).toBe(true));
    await waitFor(() => expect(within(ev).getAllByRole("listitem").map((x) => x.querySelector(".ov-event__title")!.textContent)).toEqual(["Deployed 1", "Client added 2", "Deployed again 7"]));
  });

  it("events: an empty list names the range", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.events", { range: "1h" }), { "GET /api/v1/activity": activityOf(0) }) });
    const ev = await region("Recent events");
    await waitFor(() => expect(ev).toHaveTextContent("No events in the last hour"));
  });

  it("speed test results shown", async () => {
    const r = renderApp("/", { routes: prefsRoutes(overview("running", { speedtests: speedtestsOf(5) }), saved("overview.speedTest", { shown: 5 })) });
    let sp = await region("Speed test");
    await waitFor(() => expect(sp.querySelectorAll(".ov-speed__row")).toHaveLength(5));
    r.unmount();
    renderApp("/", { routes: prefsRoutes(overview("running", { speedtests: speedtestsOf(5) }), saved("overview.speedTest", { shown: 1 })) });
    sp = await region("Speed test");
    await waitFor(() => expect(sp.querySelectorAll(".ov-speed__row")).toHaveLength(1));
  });

  it("health checks setting hides a check", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { derived: { selftestFailures: ["dns"] } }), saved("overview.health", { checks: ["vm", "wireguard", "dns", "tunnel"] })) });
    const h = await region("Health summary");
    await waitFor(() => expect(within(h).getAllByRole("listitem")).toHaveLength(4));
    expect(within(h).queryByRole("listitem", { name: /^Self-test/ })).toBeNull();
    // A hidden check does not count: the shown ones are all fine.
    expect(h).toHaveTextContent("All systems healthy");
  });

  it("cost impact sessions in chart", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.costImpact", { sessions: 4 }), { "GET /api/v1/cost": cost({ sessions: costSessionsOf(20) }) }) });
    const c = await region("Cost impact");
    await waitFor(() => expect(c.querySelectorAll("rect[data-bar]")).toHaveLength(4));
  });

  it("notes show at most", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.notes", { max: "3" }), { "GET /api/v1/session": session(notesOf(6)) }) });
    const n = await region("Watchman notes");
    await waitFor(() => expect(within(n).getAllByRole("listitem").map((x) => x.querySelector(".ov-note__msg")!.textContent)).toEqual(["Note number 1", "Note number 2", "Note number 3"]));
  });

  it("run starting step filter and log level", async () => {
    const log = ["2026-10-02T11:59:50.0000000Z ##[group]Run terraform", "2026-10-02T11:59:51.0000000Z plain line", "2026-10-02T11:59:52.0000000Z ##[error]Terraform broke", "2026-10-02T11:59:53.0000000Z ##[endgroup]"].join("\n");
    renderApp("/", {
      routes: prefsRoutes(overview("deploying"), saved("overview.run", { stepFilter: "pending", logLevel: "error" }), { "GET /api/v1/runs/run-dep/log": { log, source: "live", active: true, updatedAt: new Date().toISOString() } }),
    });
    const tabs = await screen.findByRole("tablist", { name: "Show steps" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /Pending/ })).toHaveAttribute("aria-selected", "true"));
    const pipeline = await region("Deployment pipeline");
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(5);
    const logs = await region("Live logs");
    await waitFor(() => expect(logs).toHaveTextContent("Terraform broke"));
    expect(logs).not.toHaveTextContent("plain line");
  });
});

describe("Overview widget settings: thresholds", () => {
  it("availability below 99 is amber with its word, below 90 red", async () => {
    for (const [pct, stroke, word] of [
      [99.5, "var(--green)", null],
      [98.5, "var(--amber)", "Low"],
      [85, "var(--red)", "Very low"],
    ] as const) {
      const r = renderApp("/", { routes: prefsRoutes(overview("running"), {}, { "GET /api/v1/history": history(pct) }) });
      const tile = within(await region("Key metrics")).getByRole("group", { name: "Availability" });
      await waitFor(() => expect(tile).toHaveTextContent(`${pct.toFixed(1)}%`));
      expect(ringStroke(tile)).toBe(stroke);
      if (word) expect(tile.querySelector(".tile__value .ov-tile__word")).toHaveTextContent(new RegExp(`^${word}$`));
      else expect(tile.querySelector(".tile__value .ov-tile__word")).toBeNull();
      r.unmount();
    }
    // Moved cut-offs: 96% is fine above a warn of 95.
    renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { availability: { warn: 95, bad: 80 } }), { "GET /api/v1/history": history(96) }) });
    const tile = within(await region("Key metrics")).getByRole("group", { name: "Availability" });
    await waitFor(() => expect(ringStroke(tile)).toBe("var(--green)"));
  });

  it("DNS warn threshold", async () => {
    const user = userEvent.setup();
    const cases: [object, string, string | null][] = [
      [{}, "amber", "Low"],
      [saved(KM, { dnsUp: { warn: 95, bad: null } }), "green", null],
      [saved(KM, { dnsUp: { warn: 100, bad: 98 } }), "red", "Very low"],
    ];
    for (const [prefs, tone, word] of cases) {
      const r = renderApp("/", { routes: prefsRoutes(overview("running"), prefs, { "GET /api/v1/history": history(100, 0.97) }) });
      const m = await region("Key metrics");
      await user.click(within(m).getByRole("radio", { name: "24h" }));
      const tile = within(m).getByRole("group", { name: "DNS status" });
      await waitFor(() => expect(tile).toHaveTextContent("Up 97%"));
      await waitFor(() => expect(tile.querySelector(`.tile__icon--${tone}`)).not.toBeNull());
      // Amber or red comes with a level word, as the other tiles' thresholds do.
      if (word) expect(tile.querySelector(".tile__value .ov-tile__word")).toHaveTextContent(new RegExp(`^${word}$`));
      else expect(tile.querySelector(".tile__value .ov-tile__word")).toBeNull();
      r.unmount();
    }
  });

  it("latency thresholds off by default, amber when set and exceeded", async () => {
    // 28 ms average.
    const cases: [object, string, string | null][] = [
      [{}, "blue", null],
      [saved(KM, { latency: { warn: 20, bad: null } }), "amber", "High"],
      [saved(KM, { latency: { warn: 20, bad: 25 } }), "red", "Very high"],
      [saved(KM, { latency: { warn: 50, bad: null } }), "green", null],
    ];
    for (const [prefs, tone, word] of cases) {
      const r = renderApp("/", { routes: prefsRoutes(overview("running"), prefs) });
      const tile = within(await region("Key metrics")).getByRole("group", { name: "Latency (avg)" });
      await waitFor(() => expect(tile.querySelector(`.tile__icon--${tone}`)).not.toBeNull());
      expect(tile).toHaveTextContent("28 ms");
      if (word) expect(tile.querySelector(".tile__value .ov-tile__word")).toHaveTextContent(new RegExp(`^${word}$`));
      else expect(tile.querySelector(".tile__value .ov-tile__word")).toBeNull();
      r.unmount();
    }
  });

  it("cost impact session threshold", async () => {
    const routesFor = (prefs: object) => prefsRoutes(overview("running"), prefs, { "GET /api/v1/cost": cost({ session: { running: true, since: iso(NOW_MS - 7_200_000), estimateGbp: 2 }, sessions: costSessionsOf(3) }) });
    const r = renderApp("/", { routes: routesFor({}) });
    let c = await region("Cost impact");
    await waitFor(() => expect(c).toHaveTextContent("£2.00"));
    expect(c.querySelector(".ov-cost__value")!.className).toBe("ov-cost__value");
    expect(c.querySelector(".ov-cost__word")).toBeNull();
    r.unmount();

    const r2 = renderApp("/", { routes: routesFor(saved("overview.costImpact", { session: { warn: 1.5, bad: 3 } })) });
    c = await region("Cost impact");
    await waitFor(() => expect(c.querySelector(".ov-cost__value")).toHaveClass("ov-cost__value--amber"));
    expect(c.querySelector(".ov-cost__word")).toHaveTextContent("High");
    r2.unmount();

    renderApp("/", { routes: routesFor(saved("overview.costImpact", { session: { warn: null, bad: 2 } })) });
    c = await region("Cost impact");
    await waitFor(() => expect(c.querySelector(".ov-cost__value")).toHaveClass("ov-cost__value--red"));
    expect(c.querySelector(".ov-cost__word")).toHaveTextContent("Very high");
  });
});

describe("Overview widget settings: display", () => {
  it("status banner: step progress bar, timing block and auto-destroy time", async () => {
    const r = renderApp("/", { routes: prefsRoutes(overview("deploying"), saved("overview.status", { progress: false })) });
    let b = await region("Status");
    await waitFor(() => expect(within(b).queryByRole("progressbar")).toBeNull());
    expect(b).not.toHaveTextContent("6 of 12 steps completed");
    expect(b).toHaveTextContent("Elapsed time");
    r.unmount();

    const r2 = renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.status", { autoDestroy: false })) });
    b = await region("Status");
    await waitFor(() => expect(b).not.toHaveTextContent("Auto-destroy at"));
    expect(b).not.toHaveTextContent("tears down in");
    expect(b).toHaveTextContent("Up for");
    r2.unmount();

    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.status", { timing: false })) });
    b = await region("Status");
    await waitFor(() => expect(b).not.toHaveTextContent("Up for"));
    expect(within(b).getByRole("button", { name: "Extend" })).toBeInTheDocument();
  });

  it("topology second lines and edge labels", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.topology", { secondLines: false, edgeLabels: false })) });
    const t = await region("Live topology");
    await waitFor(() => expect(t).not.toHaveTextContent("UDP 51820"));
    expect(t.querySelectorAll(".ov-node__line")).toHaveLength(0);
    expect(t).not.toHaveTextContent("10.13.13.0/24");
    expect(within(t).getByRole("button", { name: /^WireGuard endpoint/ })).toHaveTextContent("Healthy");
  });

  it("key metrics charts and sub-lines", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { charts: false, subLines: false }), { "GET /api/v1/history": history(99.5) }) });
    const m = await region("Key metrics");
    await waitFor(() => expect(m.querySelector(".tile__spark")).toBeNull());
    expect(m.querySelector(".tile__progress")).toBeNull();
    expect(m.querySelector(".ring")).toBeNull();
    expect(m.querySelector(".ov-tile__sub")).toBeNull();
    expect(within(m).getByRole("group", { name: "Public endpoint" })).not.toHaveTextContent("203.0.113.10");
  });

  it("a threshold word stays when sub-lines are off", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved(KM, { subLines: false }), { "GET /api/v1/history": history(85) }) });
    const tile = within(await region("Key metrics")).getByRole("group", { name: "Availability" });
    await waitFor(() => expect(tile.querySelector(".tile__value .ov-tile__word")).toHaveTextContent("Very low"));
    expect(tile).not.toHaveTextContent("last hour");
  });

  it("run log timestamps", async () => {
    const log = "2026-10-02T11:59:51.0000000Z plain line";
    renderApp("/", { routes: prefsRoutes(overview("deploying"), saved("overview.run", { logTimestamps: false }), { "GET /api/v1/runs/run-dep/log": { log, source: "live", active: true, updatedAt: new Date().toISOString() } }) });
    const logs = await region("Live logs");
    await waitFor(() => expect(logs).toHaveTextContent("plain line"));
    await waitFor(() => expect(logs.querySelector(".log__time")).toBeNull());
  });

  it("events detail line", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.events", { detail: false }), { "GET /api/v1/activity": activityOf(3) }) });
    const ev = await region("Recent events");
    await waitFor(() => expect(within(ev).getAllByRole("listitem")).toHaveLength(3));
    expect(ev.querySelector(".ov-event__detail")).toBeNull();
  });

  it("speed test jitter and server", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { speedtests: speedtestsOf(2) }), saved("overview.speedTest", { jitter: true, server: true })) });
    const sp = await region("Speed test");
    await waitFor(() => expect(sp).toHaveTextContent("jitter 2.5 ms"));
    expect(sp).toHaveTextContent("to home-site-1");
    expect(sp).toHaveTextContent("jitter 3.5 ms");
  });

  it("health check ages", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running", { derived: { selftestFailures: ["dns"] } }), saved("overview.health", { ages: false })) });
    const h = await region("Health summary");
    await waitFor(() => expect(within(h).getByRole("listitem", { name: /^VM reachable/ })).not.toHaveTextContent("3 s ago"));
    // A failing check keeps its word.
    expect(within(h).getByRole("listitem", { name: /^Self-test/ })).toHaveTextContent("Failing");
  });

  it("cost impact typical session line", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.costImpact", { typical: false }), { "GET /api/v1/cost": cost({ sessions: costSessionsOf(3) }) }) });
    const c = await region("Cost impact");
    await waitFor(() => expect(c).not.toHaveTextContent("typical session"));
  });

  it("notes times", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.notes", { times: false }), { "GET /api/v1/session": session(notesOf(2)) }) });
    const n = await region("Watchman notes");
    await waitFor(() => expect(within(n).getAllByRole("listitem")).toHaveLength(2));
    expect(n.querySelector(".ov-note__time")).toBeNull();
    expect(n.querySelector(".ov-note--notime")).not.toBeNull();
  });

  it("a change in the cog applies at once and is saved", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    const t = await region("Live topology");
    expect(t).toHaveTextContent("UDP 51820");
    await user.click(within(t).getByRole("button", { name: "Live topology settings" }));
    const pop = await screen.findByRole("dialog", { name: "Live topology settings" });
    const sw = within(pop).getByRole("switch", { name: "Edge labels: UDP port" });
    await waitFor(() => expect(sw).toBeEnabled());
    await user.click(sw);
    await waitFor(() => expect(t).not.toHaveTextContent("UDP 51820"));
    await waitFor(() => expect(r.fetchMock!.calls.filter((c) => c.method === "PUT" && c.url.includes("/prefs/overview"))).toHaveLength(1), { timeout: 3000 });
  });
});
