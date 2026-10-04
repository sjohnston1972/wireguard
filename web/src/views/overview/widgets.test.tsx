// widgets.test.tsx
//
// Plain English: every Overview panel is a widget with a settings cog; with
// nothing saved the page is exactly as before; hiding and reordering change
// only the row they are in; the phone keeps its own layout but follows
// what is hidden and what is set.
import "./testSetup";
import { beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { activityOf, cost, costSessionsOf, merge, notesOf, overview, prefsRoutes, routes, saved, session, speedtestsOf, vmHistory } from "./testData";
import { preloadLazy } from "@/test/lazy";

beforeAll(preloadLazy);

const region = (name: string) => screen.findByRole("region", { name });
const hide = (...ids: string[]) => ({ layout: { hidden: ids.map((x) => `overview.${x}`) } });
const order = (row: string, keys: string[]) => ({ layout: { order: { [row]: keys.map((k) => (k === "side" ? k : `overview.${k}`)) } } });
/** The row div holding a panel (the region, or the side stack's region). */
const rowOf = (el: HTMLElement) => el.closest(".ov-row") as HTMLElement;
const titles = (row: HTMLElement) => Array.from(row.querySelectorAll(".panel__title")).map((h) => h.textContent);

const PANELS: [string, string][] = [
  ["Live topology", "Live topology"],
  ["Key metrics", "Key metrics"],
  ["Last run", "Last run"],
  ["Network traffic", "Network traffic"],
  ["Recent events", "Recent events"],
  ["Speed test", "Speed test"],
  ["Health summary", "Health summary"],
  ["Cost impact", "Cost impact"],
  ["Watchman notes", "Watchman notes"],
];

describe("Overview widgets: the frame", () => {
  it("overview: every panel is a widget", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const banner = await region("Status");
    expect(within(banner).getByRole("button", { name: "Status banner settings" })).toBeInTheDocument();
    for (const [name, title] of PANELS) expect(within(await region(name)).getByRole("button", { name: `${title} settings` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Layout" })).toBeInTheDocument();
  });

  it("during a run the run widget's cog sits on the pipeline, once", async () => {
    renderApp("/", { routes: routes(overview("deploying")) });
    const pipeline = await region("Deployment pipeline");
    expect(within(pipeline).getByRole("button", { name: "Last run settings" })).toBeInTheDocument();
    expect(within(await region("Live logs")).queryByRole("button", { name: /settings$/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Last run settings" })).toHaveLength(1);
  });

  it("with no prefs overview renders today's tiles, columns, ranges and colours", async () => {
    const r = renderApp("/", {
      routes: routes(overview("running", { speedtests: speedtestsOf(5) }), {
        "GET /api/v1/activity": activityOf(8),
        "GET /api/v1/cost": cost({ sessions: costSessionsOf(20) }),
        "GET /api/v1/session": session(notesOf(6)),
        "GET /api/v1/history": vmHistory("1h", { availability: { expected: 60, received: 57, pct: 95 } }),
      }),
    });
    // Key metrics: Live, seven tiles as three over four, availability amber below 99.
    const m = await region("Key metrics");
    expect(within(m).getByRole("radio", { name: "Live" })).toHaveAttribute("aria-checked", "true");
    const tileRows = Array.from(m.querySelectorAll(".ov-tiles__row"));
    expect(tileRows.map((x) => x.className)).toEqual(["ov-tiles__row ov-tiles__row--3", "ov-tiles__row ov-tiles__row--4"]);
    expect(tileRows.map((x) => Array.from(x.querySelectorAll(".ov-tile")).map((t) => t.getAttribute("aria-label")))).toEqual([
      ["Public endpoint", "Connected clients", "Latency (avg)"],
      ["DNS status", "Heartbeat (VM)", "Session cost", "Availability"],
    ]);
    await waitFor(() => expect(within(m).getByRole("group", { name: "Availability" })).toHaveTextContent("95.0%"));
    expect(within(m).getByRole("group", { name: "Availability" }).querySelectorAll("circle")[1]).toHaveAttribute("stroke", "var(--amber)");
    expect(within(m).getByRole("group", { name: "Connected clients" }).querySelector(".tile__progress")).not.toBeNull();
    expect(within(m).getByRole("group", { name: "Latency (avg)" }).querySelector(".tile__spark")).not.toBeNull();
    expect(within(m).getByRole("group", { name: "Latency (avg)" }).querySelector(".tile__icon--blue")).not.toBeNull();
    expect(within(m).getByRole("group", { name: "Public endpoint" })).toHaveTextContent("203.0.113.10");

    // Rows keep the page's own CSS columns: nothing inline.
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ov-row"));
    expect(rows.map((x) => x.className)).toEqual(["ov-row ov-row--2", "ov-row ov-row--3", "ov-row ov-row--4"]);
    for (const x of [...rows, document.querySelector(".ov-rows")!]) expect(x.getAttribute("style")).toBeNull();
    expect(titles(rows[1])).toEqual(["Last run", "Network traffic", "Recent events", "Speed test"]);
    expect(document.querySelector(".ov-side")!.className).toBe("ov-side");

    // Traffic: Session, in KB/s, both series, no peak line.
    const t = await region("Network traffic");
    expect(within(t).getByRole("radio", { name: "Session" })).toHaveAttribute("aria-checked", "true");
    expect(within(t).getAllByRole("radio").map((x) => x.textContent)).toEqual(["5m", "15m", "1h", "Session"]);
    const summary = within(t).getByTestId("chart-summary");
    expect(summary).toHaveTextContent(/In: latest [\d.]+ KB\/s/);
    expect(summary).toHaveTextContent(/Out: latest [\d.]+ KB\/s/);
    expect(summary).not.toHaveTextContent("peak:");

    // Recent events: five, over 24 hours, with detail lines.
    const ev = await region("Recent events");
    await waitFor(() => expect(within(ev).getAllByRole("listitem")).toHaveLength(5));
    expect(ev.querySelectorAll(".ov-event__detail")).toHaveLength(5);
    expect(r.fetchMock!.calls.some((c) => c.url.includes("/activity?range=24h"))).toBe(true);

    // Speed tests: the latest three, no jitter or server.
    const sp = await region("Speed test");
    expect(sp.querySelectorAll(".ov-speed__row")).toHaveLength(3);
    expect(sp).not.toHaveTextContent(/jitter|home-site/);

    // Cost impact: sixteen bars and the typical session.
    const c = await region("Cost impact");
    await waitFor(() => expect(c.querySelectorAll("rect[data-bar]")).toHaveLength(16));
    expect(c).toHaveTextContent("typical session");

    // Health: all five checks with ages; notes: all six with times.
    const h = await region("Health summary");
    expect(within(h).getAllByRole("listitem")).toHaveLength(5);
    expect(within(h).getByRole("listitem", { name: /^VM reachable/ })).toHaveTextContent("3 s ago");
    const n = await region("Watchman notes");
    await waitFor(() => expect(within(n).getAllByRole("listitem")).toHaveLength(6));
    expect(n.querySelectorAll(".ov-note__time")).toHaveLength(6);

    // Topology: second lines and the edge label. Banner: timing with the auto-destroy time.
    const topo = await region("Live topology");
    expect(topo).toHaveTextContent("UDP 51820");
    expect(topo).toHaveTextContent("10.13.13.0/24");
    const b = await region("Status");
    expect(b).toHaveTextContent(/Auto-destroy at/);
    expect(b).toHaveTextContent(/tears down in/);
  });
});

describe("Overview widgets: layout", () => {
  it("hiding topology widens key metrics", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), hide("topology")) });
    const m = await region("Key metrics");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Live topology" })).toBeNull());
    const row = rowOf(m);
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(titles(row)).toEqual(["Key metrics"]);
  });

  it("hiding speed test gives recent events the side column", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), hide("speedTest")) });
    const ev = await region("Recent events");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Speed test" })).toBeNull());
    const side = ev.closest(".ov-side") as HTMLElement;
    expect(side).toHaveClass("ov-side--one");
    expect(titles(side)).toEqual(["Recent events"]);
    // The side stack keeps its weight, so the row's columns are unchanged.
    expect(rowOf(ev).style.gridTemplateColumns).toBe("minmax(0, 41fr) minmax(0, 45fr) minmax(0, 32fr)");
  });

  it("the reordered layout renders in the saved order", async () => {
    const prefs = merge(order("r2", ["keyMetrics", "topology"]), order("r3", ["side", "traffic", "run"]), order("r4", ["notes", "costImpact", "health"]));
    renderApp("/", { routes: prefsRoutes(overview("running"), prefs) });
    await region("Key metrics");
    await waitFor(() => expect(titles(document.querySelectorAll<HTMLElement>(".ov-row")[0])).toEqual(["Key metrics", "Live topology"]));
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ov-row"));
    expect(titles(rows[1])).toEqual(["Recent events", "Speed test", "Network traffic", "Last run"]);
    expect(rows[1].style.gridTemplateColumns).toBe("minmax(0, 32fr) minmax(0, 45fr) minmax(0, 41fr)");
    expect(titles(rows[2])).toEqual(["Watchman notes", "Cost impact", "Health summary"]);
    expect(rows[2].style.gridTemplateColumns).toBe("minmax(0, 32fr) minmax(0, 32fr) minmax(0, 54fr)");
  });

  it("a row with nothing visible is not rendered and its track goes", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), hide("health", "costImpact", "notes")) });
    await region("Key metrics");
    await waitFor(() => expect(document.querySelectorAll(".ov-row")).toHaveLength(2));
    // The page keeps the other rows' heights (their own tracks).
    expect(document.querySelector(".ov-rows")!.className).toBe("ov-rows ov-rows--r2-r3");
  });

  it("during a run the run widget widens over traffic and traffic joins the side stack, hidden widgets stay hidden", async () => {
    // Default: the page's own CSS (the run spans two columns), traffic under events.
    const r = renderApp("/", { routes: routes(overview("deploying")) });
    const pipeline = await region("Deployment pipeline");
    let row = rowOf(pipeline);
    expect(row.getAttribute("style")).toBeNull();
    expect(Array.from(row.children).map((x) => x.className)).toEqual(["ov-run", "ov-side"]);
    expect(titles(row.querySelector(".ov-side")!)).toEqual(["Recent events", "Network traffic"]);
    r.unmount();

    // Events hidden: traffic alone in the side stack; speed test never shows during a run.
    const r2 = renderApp("/", { routes: prefsRoutes(overview("deploying"), hide("events")) });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Recent events" })).toBeNull());
    row = rowOf(await region("Deployment pipeline"));
    expect(titles(row.querySelector(".ov-side")!)).toEqual(["Network traffic"]);
    expect(row.querySelector(".ov-side")).toHaveClass("ov-side--one");
    expect(screen.queryByRole("region", { name: "Speed test" })).toBeNull();
    expect(row).toHaveClass("ov-row--custom");
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 86fr) minmax(0, 32fr)");
    r2.unmount();

    // Traffic and events hidden: the run takes the whole row.
    const r3 = renderApp("/", { routes: prefsRoutes(overview("deploying"), hide("events", "traffic")) });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Network traffic" })).toBeNull());
    row = rowOf(await region("Deployment pipeline"));
    expect(row.querySelector(".ov-side")).toBeNull();
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 86fr)");
    r3.unmount();

    // The user's order: the side stack first, then the run.
    renderApp("/", { routes: prefsRoutes(overview("deploying"), order("r3", ["side", "run", "traffic"])) });
    await waitFor(() => expect(Array.from(rowOf(screen.getByRole("region", { name: "Deployment pipeline" })).children).map((x) => x.className)).toEqual(["ov-side", "ov-run"]));
    row = rowOf(await region("Deployment pipeline"));
    expect(row.style.gridTemplateColumns).toBe("minmax(0, 32fr) minmax(0, 86fr)");
    expect(titles(row.querySelector(".ov-side")!)).toEqual(["Recent events", "Network traffic"]);
  });

  it("during a run traffic in the side stack has no handle of its own; its cog and the run's move what is drawn", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: prefsRoutes(overview("deploying"), {}) });
    const traffic = await region("Network traffic");
    await waitFor(() => expect(within(traffic).getByRole("button", { name: "Network traffic settings" })).toBeEnabled());
    // Traffic sits under events now: the column's handle is on events, none on traffic.
    expect(screen.queryByRole("button", { name: /^Move Network traffic/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Recent events column" })).toBeInTheDocument();
    await user.click(within(traffic).getByRole("button", { name: "Network traffic settings" }));
    const pop = await screen.findByRole("dialog", { name: "Network traffic settings" });
    expect(within(pop).queryByRole("button", { name: "Move left" })).toBeNull();
    expect(within(pop).getByRole("button", { name: "Move column right" })).toBeDisabled();
    await user.click(within(pop).getByRole("button", { name: "Move column left" }));
    // The side stack swapped with the run (what is drawn), not with traffic's hidden-for-now slot.
    await waitFor(() => expect(Array.from(rowOf(screen.getByRole("region", { name: "Deployment pipeline" })).children).map((x) => x.className)).toEqual(["ov-side", "ov-run"]));
    await user.keyboard("{Escape}");
    // The run: one move left puts it back.
    const handle = screen.getByRole("button", { name: "Move Last run" });
    handle.focus();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(Array.from(rowOf(screen.getByRole("region", { name: "Deployment pipeline" })).children).map((x) => x.className)).toEqual(["ov-run", "ov-side"]);
  });

  it("with the run widget hidden a run leaves the row as it is without one", async () => {
    renderApp("/", { routes: prefsRoutes(overview("deploying"), hide("run")) });
    const t = await region("Network traffic");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Deployment pipeline" })).toBeNull());
    expect(titles(rowOf(t))).toEqual(["Network traffic", "Recent events", "Speed test"]);
    expect(rowOf(t).style.gridTemplateColumns).toBe("minmax(0, 45fr) minmax(0, 32fr)");
  });

  it("status banner cannot be hidden", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    const b = await region("Status");
    await user.click(within(b).getByRole("button", { name: "Status banner settings" }));
    const pop = await screen.findByRole("dialog", { name: "Status banner settings" });
    expect(within(pop).queryByRole("button", { name: "Hide widget" })).toBeNull();
    expect(within(pop).getByRole("switch", { name: "Step progress bar" })).toBeInTheDocument();
  });

  it("Hide widget in a cog removes the panel and the Layout menu brings it back", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    const n = await region("Watchman notes");
    await user.click(within(n).getByRole("button", { name: "Watchman notes settings" }));
    const pop = await screen.findByRole("dialog", { name: "Watchman notes settings" });
    await waitFor(() => expect(within(pop).getByRole("button", { name: "Hide widget" })).toBeEnabled());
    await user.click(within(pop).getByRole("button", { name: "Hide widget" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Watchman notes" })).toBeNull());
    expect(rowOf(await region("Cost impact")).style.gridTemplateColumns).toBe("minmax(0, 54fr) minmax(0, 32fr)");
    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add widgets…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Add widgets" })).getByRole("switch", { name: "Watchman notes" }));
    await user.keyboard("{Escape}");
    expect(await region("Watchman notes")).toBeInTheDocument();
  });
});

describe("Overview widgets: the phone", () => {
  it("phone: a hidden widget's block is gone and settings apply to its phone content", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    const prefs = merge(hide("topology", "run"), saved("overview.status", { progress: false }), saved("overview.health", { checks: ["vm", "dns"], ages: false }), saved("overview.keyMetrics", { tiles: ["heartbeat"] }));
    renderApp("/", { routes: prefsRoutes(overview("deploying"), prefs) });
    const page = await region("Environment status");
    // Hidden topology: the compact topology strip goes. Hidden run: no Steps or Log buttons.
    await waitFor(() => expect(within(page).queryByRole("list", { name: "Topology" })).toBeNull());
    expect(within(page).queryByRole("button", { name: "Steps" })).toBeNull();
    expect(within(page).queryByRole("button", { name: "Log" })).toBeNull();
    // Status: the step progress bar is off.
    expect(within(page).queryByRole("progressbar")).toBeNull();
    // Details: key metrics tiles choose the figures, health its checks (no ages).
    await user.click(within(page).getByRole("button", { name: "Details" }));
    const sheet = await screen.findByRole("dialog", { name: "Details" });
    expect(sheet).toHaveTextContent("Heartbeat");
    expect(sheet).not.toHaveTextContent("Session cost");
    expect(sheet).not.toHaveTextContent("Public IP");
    expect(sheet).toHaveTextContent("Region");
    const checks = within(sheet).getByRole("list", { name: "Health checks" });
    expect(within(checks).getAllByRole("listitem").map((x) => x.querySelector(".ov-light__name")!.textContent)).toEqual(["VM reachable", "DNS resolving"]);
  });

  it("phone: with nothing saved the phone is as before; the run's log follows Log timestamps", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    const o = overview("deploying");
    const extra = { [`GET /api/v1/runs/run-dep/log`]: { log: "2026-10-02T11:59:58.0000000Z Starting the run", source: "live", active: true, updatedAt: null } };
    const r = renderApp("/", { routes: routes(o, extra) });
    let page = await region("Environment status");
    expect(within(page).getByRole("list", { name: "Topology" })).toBeInTheDocument();
    expect(within(page).getByRole("progressbar")).toBeInTheDocument();
    await user.click(within(page).getByRole("button", { name: "Log" }));
    let sheet = await screen.findByRole("dialog", { name: "Log" });
    await waitFor(() => expect(sheet.querySelector(".log__time")).not.toBeNull());
    r.unmount();

    renderApp("/", { routes: prefsRoutes(o, saved("overview.run", { logTimestamps: false }), extra) });
    page = await region("Environment status");
    await user.click(within(page).getByRole("button", { name: "Log" }));
    sheet = await screen.findByRole("dialog", { name: "Log" });
    await waitFor(() => expect(within(sheet).getByText(/Starting the run/)).toBeInTheDocument());
    await waitFor(() => expect(sheet.querySelector(".log__time")).toBeNull());
  });

  it("phone: no reorder; the Layout menu lists all ten widgets", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/", { routes: prefsRoutes(overview("running"), {}) });
    await region("Environment status");
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(await screen.findByRole("menuitem", { name: "Widget settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Overview widget settings" });
    expect(within(sheet).getAllByRole("button", { name: /settings$/ })).toHaveLength(10);
  });
});
