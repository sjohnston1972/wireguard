import "./testSetup";
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PagePrefs, SettingValue } from "@shared/api";
import { renderApp } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { clientList, clientRoutes, NOW } from "./testData";

/** Saved settings for clients widgets: { "clients.table": { columns: [...] } }. */
function prefs(settings: Record<string, Record<string, SettingValue>> = {}, layout?: PagePrefs["layout"]): PagePrefs {
  return { ...(layout ? { layout } : {}), widgets: Object.fromEntries(Object.entries(settings).map(([id, s]) => [id, { v: 1, s }])) };
}

function renderClients(p: PagePrefs | null = null, over: Parameters<typeof clientRoutes>[0] = {}, url = "/clients") {
  const server = prefsServer(p ? { clients: p } : {});
  const r = renderApp(url, { routes: { ...clientRoutes(over), ...server.routes } });
  return { ...r, server };
}

const table = () => screen.findByRole("table", { name: "Clients" });
const headers = (t: HTMLElement) => within(t).getAllByRole("columnheader").map((h) => (h.textContent ?? "").trim());
const rowNames = (t: HTMLElement) =>
  within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent ?? "");
const kpiTiles = () => within(screen.getByRole("group", { name: /Client counts/ })).getAllByRole("button").filter((b) => b.classList.contains("filter-tile"));
const names = (t: HTMLElement) => Array.from(t.querySelectorAll(".cname__name")).map((e) => e.textContent);
const talkerRows = () => within(screen.getByRole("list", { name: /^Traffic .*by client this session$|^Traffic by client this session$/ })).getAllByRole("listitem");

/** Seven distinct talkers by tunnel address, biggest first by `up`. */
const talkers = (n = 7) =>
  Array.from({ length: n }, (_, i) => ({ c: `198.51.100.${i + 1}`, r: "203.0.113.5", name: null, up: (n - i) * 1_000_000, down: 0, bu: 0, bd: i * 500_000, at: NOW }));

describe("Clients widgets: frame and defaults", { timeout: 20_000 }, () => {
  it("clients: every panel is a widget", async () => {
    renderClients();
    await table();
    for (const t of ["Client figures", "Clients", "Top talkers", "Client status", "Traffic this session"]) {
      expect(screen.getByRole("button", { name: `${t} settings` })).toBeInTheDocument();
    }
  });

  it("with no prefs clients renders today's tiles, columns, ranges and colours", async () => {
    const { fetchMock, container } = renderClients(null, { talkers: talkers() });
    const t = await table();
    expect(kpiTiles()).toHaveLength(6);
    expect(headers(t).slice(0, 8)).toEqual(["Name", "Address", "Status", "Last handshake", "Latency", "Session traffic", "Allowed IPs", "Expires"]);
    expect(headers(t).filter((h) => h !== "Actions")).toHaveLength(8);
    expect(names(t)).toEqual(["backup-box", "build-server", "guest-ipad", "home-site", "laptop", "old-tablet", "phone"]);
    expect(container.querySelector(".clat__spark")).not.toBeNull();
    expect(container.querySelector(".dt--compact")).toBeNull();
    // starting filter All, nothing pressed
    expect(screen.getByRole("tab", { name: "All (7)" })).toHaveAttribute("aria-selected", "true");
    expect(talkerRows()).toHaveLength(5);
    // donut legend: percentages and both extras
    expect(screen.getByText(/Expiring ≤ 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/Full-tunnel clients/, { selector: "li" })).toBeInTheDocument();
    expect(container.querySelectorAll(".cstatus__legend .cstatus__share").length).toBeGreaterThanOrEqual(3);
    // session traffic: both series, from the heartbeat history, no history fetch
    expect(screen.getByRole("region", { name: "Traffic this session" })).toBeInTheDocument();
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Inbound.*Outbound/);
    expect(fetchMock!.calls.some((c) => c.url.includes("/history?scope=vm"))).toBe(false);
    // no latency colouring without thresholds
    expect(container.querySelector(".clat .ctag")).toBeNull();
  });
});

describe("Clients widgets: data settings", { timeout: 20_000 }, () => {
  it("starting filter and sort apply when the URL has none", async () => {
    const user = userEvent.setup();
    renderClients(prefs({ "clients.table": { filter: "online", sort: "latency" } }));
    const t = await table();
    expect(screen.getByRole("tab", { name: "Online (2)" })).toHaveAttribute("aria-selected", "true");
    // Latency lowest first: home-site 18 ms, phone 32 ms.
    await waitFor(() => expect(rowNames(t)).toHaveLength(2));
    expect(rowNames(t)[0]).toMatch(/home-site/);
    // The in-panel controls still change the view for the visit.
    await user.click(screen.getByRole("tab", { name: "All (7)" }));
    expect(rowNames(t)).toHaveLength(7);
  });

  it("a starting filter or sort that changes later starts the controls again (useStarting, as on other pages)", async () => {
    const user = userEvent.setup();
    const { server, client } = renderClients(prefs({ "clients.table": { filter: "online" } }));
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toHaveLength(2));
    // A pick in the panel lasts for the visit...
    await user.click(screen.getByRole("tab", { name: /^Offline/ }));
    expect(screen.getByRole("tab", { name: /^Offline/ })).toHaveAttribute("aria-selected", "true");
    // ...until the setting itself changes (another device, or the cog): then the view starts again from it.
    server.state.pages.clients = { version: 2, updatedAt: NOW, prefs: prefs({ "clients.table": { filter: "home", sort: "nameDesc" } }) };
    await act(async () => {
      await client.refetchQueries({ queryKey: ["prefs"] });
    });
    await waitFor(() => expect(rowNames(t)).toHaveLength(1));
    expect(rowNames(t)[0]).toMatch(/home-site/);
    await user.click(screen.getByRole("tab", { name: "All (7)" }));
    expect(rowNames(t)[0]).toMatch(/^phone/);
  });

  it("starting filter Home site and sort Name Z to A", async () => {
    renderClients(prefs({ "clients.table": { filter: "home" } }));
    const t = await table();
    await waitFor(() => expect(rowNames(t)).toHaveLength(1));
    expect(rowNames(t)[0]).toMatch(/home-site/);
  });

  it("starting sort Name Z to A", async () => {
    renderClients(prefs({ "clients.table": { sort: "nameDesc" } }));
    const t = await table();
    await waitFor(() => expect(rowNames(t)[0]).toMatch(/^phone/));
  });

  it("starting sort works even when its column is not shown", async () => {
    renderClients(prefs({ "clients.table": { sort: "address", columns: ["latency"] } }));
    const t = await table();
    await waitFor(() => expect(headers(t)).not.toContain("Address"));
    // 10.13.13.3, .4, .7, .8, .10, .12, .14
    expect(names(t)).toEqual(["phone", "laptop", "old-tablet", "backup-box", "home-site", "build-server", "guest-ipad"]);
  });

  it("columns setting adds IPv6 address, Created and Note and removes Allowed IPs", async () => {
    const list = clientList();
    list[1] = { ...list[1]!, ip6: "fd13:13::3", note: "Steven's phone, work SIM" };
    renderClients(prefs({ "clients.table": { columns: ["address", "handshake", "latency", "traffic", "expires", "ipv6", "created", "note"] } }), { clients: list });
    const t = await table();
    await waitFor(() => expect(headers(t)).toContain("IPv6 address"));
    expect(headers(t)).not.toContain("Allowed IPs");
    expect(headers(t).filter((h) => h !== "Actions")).toEqual(["Name", "Address", "Status", "Last handshake", "Latency", "Session traffic", "Expires", "IPv6 address", "Created", "Note"]);
    const phone = within(t).getAllByRole("row").find((r) => within(r).queryAllByRole("cell")[0]?.textContent?.startsWith("phone"))!;
    expect(phone).toHaveTextContent("fd13:13::3");
    expect(phone).toHaveTextContent("Steven's phone, work SIM");
    expect(phone).toHaveTextContent("3 Aug 2026");
  });

  it("no optional columns leaves Name, Status and the menu", async () => {
    renderClients(prefs({ "clients.table": { columns: [] } }));
    const t = await table();
    await waitFor(() => expect(headers(t).filter((h) => h !== "Actions")).toEqual(["Name", "Status"]));
  });

  it("kpi tiles setting", async () => {
    const { container } = renderClients(prefs({ "clients.kpis": { tiles: ["online", "latency"] } }));
    await table();
    await waitFor(() => expect(kpiTiles()).toHaveLength(2));
    expect(kpiTiles()[0]).toHaveTextContent("Online now");
    expect(kpiTiles()[1]).toHaveTextContent("Average latency");
    expect(container.querySelector(".kpis")).toHaveStyle({ "--kpi-cols": "2" });
  });

  it("talkers rows and measure Sent sums up+bu", async () => {
    const t = [
      { c: "10.13.13.3", r: "203.0.113.5", name: null, up: 1_000_000, down: 9_000_000, bu: 2_000_000, bd: 0, at: NOW },
      { c: "10.13.13.10", r: "203.0.113.9", name: null, up: 4_000_000, down: 2_000_000, bu: 0, bd: 7_000_000, at: NOW },
      ...talkers(5).map((x, i) => ({ ...x, up: 100_000 * (i + 1), bu: 0, bd: 0 })),
    ];
    renderClients(prefs({ "clients.talkers": { rows: 3, measure: "sent" } }), { talkers: t });
    await table();
    await waitFor(() => expect(talkerRows()).toHaveLength(3));
    // sent = up + bu: phone 3 MB, home-site 4 MB, then the .5 talker at 500 KB
    expect(talkerRows()[0]).toHaveTextContent("home-site");
    expect(talkerRows()[0]).toHaveTextContent("4 MB");
    expect(talkerRows()[1]).toHaveTextContent("phone");
    expect(talkerRows()[1]).toHaveTextContent("3 MB");
  });

  it("talkers measure Received sums down+bd", async () => {
    const t = [
      { c: "10.13.13.3", r: "203.0.113.5", name: null, up: 1_000_000, down: 9_000_000, bu: 2_000_000, bd: 0, at: NOW },
      { c: "10.13.13.10", r: "203.0.113.9", name: null, up: 4_000_000, down: 2_000_000, bu: 0, bd: 8_000_000, at: NOW },
    ];
    renderClients(prefs({ "clients.talkers": { measure: "received" } }), { talkers: t });
    await table();
    await waitFor(() => expect(talkerRows()[0]).toHaveTextContent("10 MB"));
    expect(talkerRows()[0]).toHaveTextContent("home-site");
    expect(talkerRows()[1]).toHaveTextContent("9 MB");
  });

  it("talkers rows 10 shows up to ten", async () => {
    renderClients(prefs({ "clients.talkers": { rows: 10 } }), { talkers: talkers(12) });
    await table();
    await waitFor(() => expect(talkerRows()).toHaveLength(10));
  });

  it("session traffic 7d reads vm history", async () => {
    const { fetchMock } = renderClients(prefs({ "clients.sessionTraffic": { range: "7d" } }));
    await table();
    await waitFor(() => expect(fetchMock!.calls.some((c) => c.url.includes("/history?scope=vm&range=7d"))).toBe(true));
    expect(screen.getByRole("region", { name: /Traffic, last 7 days/ })).toBeInTheDocument();
  });

  it("session traffic history rates become the chart's series; units Mbit/s", async () => {
    const points = [
      { t: "2026-10-01T10:00:00.000Z", expected: 1, received: 1, load1: 0, rx_rate: 2_000_000, tx_rate: 500_000, rx_rate_max: null, tx_rate_max: null, peers_online: 1, dns_up: 1 },
      { t: "2026-10-01T11:00:00.000Z", expected: 1, received: 1, load1: 0, rx_rate: 1_000_000, tx_rate: 250_000, rx_rate_max: null, tx_rate_max: null, peers_online: 1, dns_up: 1 },
    ];
    const server = prefsServer({ clients: prefs({ "clients.sessionTraffic": { range: "24h", units: "mbps" } }) });
    renderApp("/clients", { routes: { ...clientRoutes(), "GET /api/v1/history": { range: "24h", step: 300, from: NOW, to: NOW, points, latest: points[1]!.t }, ...server.routes } });
    await table();
    // 1 MB/s = 8 Mbit/s: the latest inbound value is 8 Mbit/s, the peak 16
    await waitFor(() => expect(screen.getByTestId("chart-summary")).toHaveTextContent("Inbound: latest 8 Mbit/s, peak 16 Mbit/s"));
  });

  it("units Mbit/s on the session range converts the heartbeat samples", async () => {
    renderClients(prefs({ "clients.sessionTraffic": { units: "mbps" } }), {
      trafficHist: [
        { t: "2026-10-02T11:50:00.000Z", rx: 250_000, tx: 125_000 },
        { t: "2026-10-02T11:55:00.000Z", rx: 125_000, tx: 125_000 },
      ],
    });
    await table();
    await waitFor(() => expect(screen.getByTestId("chart-summary")).toHaveTextContent("Inbound: latest 1 Mbit/s, peak 2 Mbit/s"));
  });

  it("series Outbound only", async () => {
    renderClients(prefs({ "clients.sessionTraffic": { series: ["out"] } }));
    await table();
    await waitFor(() => expect(screen.getByTestId("chart-summary")).not.toHaveTextContent("Inbound"));
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("Outbound");
  });
});

describe("Clients widgets: thresholds and display", { timeout: 20_000 }, () => {
  it("latency thresholds colour the tile and the latency cell with a word", async () => {
    // average 25 ms; home-site 18 ms, phone 32 ms
    const { container } = renderClients(prefs({ "clients.kpis": { latency: { warn: 25, bad: 40 } }, "clients.table": { latency: { warn: 20, bad: 30 } } }));
    const t = await table();
    const tile = () => screen.getByRole("button", { name: /Average latency/ });
    // 25 is at warn: amber with its word
    await waitFor(() => expect(tile()).toHaveTextContent("Slow"));
    expect(tile().querySelector(".tile__icon--amber")).not.toBeNull();
    const row = (n: string) => within(t).getAllByRole("row").find((r) => within(r).queryAllByRole("cell")[0]?.textContent?.startsWith(n))!;
    expect(row("home-site")).not.toHaveTextContent(/slow/i); // 18 < 20
    expect(row("phone")).toHaveTextContent("Very slow"); // 32 >= 30
    expect(container.querySelectorAll(".clat .ctag--red")).toHaveLength(1);
  });

  it("latency tile is red with its word at the bad threshold and plain just below warn", async () => {
    renderClients(prefs({ "clients.kpis": { latency: { warn: 26, bad: 25 } } }));
    // warn must come before bad for "above": 26 > 25 is invalid, so the saved value is dropped and nothing is coloured
    await table();
    expect(screen.getByRole("button", { name: /Average latency/ })).not.toHaveTextContent(/slow/i);
  });

  it("latency tile at the bad cutoff is red and says Very slow", async () => {
    renderClients(prefs({ "clients.kpis": { latency: { warn: 20, bad: 25 } } }));
    await table();
    const tile = screen.getByRole("button", { name: /Average latency/ });
    await waitFor(() => expect(tile).toHaveTextContent("Very slow"));
    expect(tile.querySelector(".tile__icon--red")).not.toBeNull();
  });

  it("latency tile just below warn is unchanged", async () => {
    renderClients(prefs({ "clients.kpis": { latency: { warn: 26, bad: null } } }));
    await table();
    const tile = screen.getByRole("button", { name: /Average latency/ });
    expect(tile).not.toHaveTextContent(/slow/i);
    expect(tile.querySelector(".tile__icon--amber")).toBeNull();
  });

  it("kpi sub-lines off and online ring off", async () => {
    const { container } = renderClients(prefs({ "clients.kpis": { subLines: false, onlineRing: false } }));
    await table();
    await waitFor(() => expect(container.querySelector(".kpis .tile__sub")).toBeNull());
    expect(container.querySelector(".kpis .ring, .kpis [role='img'][aria-label='Online now']")).toBeNull();
  });

  it("compact density", async () => {
    const { container } = renderClients(prefs({ "clients.table": { density: "compact" } }));
    await table();
    await waitFor(() => expect(container.querySelector(".ctable.dt--compact")).not.toBeNull());
  });

  it("latency sparkline off", async () => {
    const { container } = renderClients(prefs({ "clients.table": { sparkline: false } }));
    await table();
    await waitFor(() => expect(container.querySelector(".clat__spark")).toBeNull());
    expect(container.querySelector(".clat__value")).not.toBeNull();
  });

  it("donut percentages off and legend extras", async () => {
    const { container } = renderClients(prefs({ "clients.statusDonut": { percentages: false, extras: ["fullTunnel"] } }));
    await table();
    await waitFor(() => expect(container.querySelectorAll(".cstatus__share")).toHaveLength(0));
    expect(screen.queryByText(/Expiring ≤ 7 days/)).not.toBeInTheDocument();
    expect(screen.getByText(/Full-tunnel clients/, { selector: "li" })).toBeInTheDocument();
    // swatches stay at the left
    expect(container.querySelector(".cstatus__legend li > span:first-child")).toHaveClass("cstatus__sw");
  });

  it("donut with no extras", async () => {
    renderClients(prefs({ "clients.statusDonut": { extras: [] } }));
    await table();
    await waitFor(() => expect(screen.queryByText(/Full-tunnel clients/, { selector: "li" })).not.toBeInTheDocument());
    expect(screen.queryByText(/Expiring ≤ 7 days/)).not.toBeInTheDocument();
  });
});

describe("Clients widgets: layout", { timeout: 20_000 }, () => {
  const lower = (c: HTMLElement) => c.querySelector<HTMLElement>(".lower");

  it("hiding talkers widens the other two", async () => {
    const { container } = renderClients(prefs({}, { hidden: ["clients.talkers"] }));
    await table();
    await waitFor(() => expect(screen.queryByRole("region", { name: /Top talkers/ })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Client status" })).toBeInTheDocument();
    expect(lower(container)!.children).toHaveLength(2);
    expect(lower(container)!.style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });

  it("the reordered layout renders in the saved order", async () => {
    const { container } = renderClients(prefs({}, { order: { r3: ["clients.sessionTraffic", "clients.statusDonut", "clients.talkers"] } }));
    await table();
    await waitFor(() => expect(lower(container)!.firstElementChild).toHaveAccessibleName("Traffic this session"));
    expect(lower(container)!.lastElementChild).toHaveAccessibleName(/Top talkers/);
  });

  it("the table cannot be hidden", async () => {
    renderClients();
    await table();
    await userEvent.setup().click(screen.getByRole("button", { name: "Clients settings" }));
    expect(screen.queryByRole("button", { name: "Hide widget" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("the table still fills the space when the lower row is entirely hidden", async () => {
    const { container } = renderClients(prefs({}, { hidden: ["clients.talkers", "clients.statusDonut", "clients.sessionTraffic"] }));
    const t = await table();
    await waitFor(() => expect(lower(container)).toBeNull());
    expect(t).toBeInTheDocument();
    // the table panel is the flexible child of the column, as today
    expect(container.querySelector(".clients__main > .clients__table-panel")).not.toBeNull();
  });

  it("hiding the kpis removes the tile row", async () => {
    const { container } = renderClients(prefs({}, { hidden: ["clients.kpis"] }));
    await table();
    await waitFor(() => expect(container.querySelector(".kpis")).toBeNull());
    expect(screen.getByRole("tab", { name: "All (7)" })).toBeInTheDocument();
  });
});

describe("Clients widgets: phone", { timeout: 20_000 }, () => {
  it("phone: summary line follows kpis tiles; the list follows filter and sort", async () => {
    setViewport("phone");
    renderClients(prefs({ "clients.kpis": { tiles: ["online"] }, "clients.table": { filter: "online", sort: "nameDesc" } }));
    const list = await screen.findByRole("list", { name: "Clients" });
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent(/^phone/);
    expect(screen.getByText(/online/, { selector: "p" })).toHaveTextContent(/^2 online$/);
    expect(screen.getByText(/online/, { selector: "p" })).not.toHaveTextContent("average");
  });

  it("phone: a starting filter is shown above the list with a way to clear it", async () => {
    setViewport("phone");
    renderClients(prefs({ "clients.table": { filter: "online" } }));
    const list = await screen.findByRole("list", { name: "Clients" });
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    expect(screen.getByText(/Showing/, { selector: "p" })).toHaveTextContent("Showing Online clients only");
    await userEvent.setup().click(screen.getByRole("button", { name: "Show all clients" }));
    expect(within(list).getAllByRole("button")).toHaveLength(7);
    expect(screen.queryByText(/Showing/, { selector: "p" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all clients" })).toBeNull();
  });

  it("phone with no prefs keeps today's summary and list order", async () => {
    setViewport("phone");
    renderClients();
    const list = await screen.findByRole("list", { name: "Clients" });
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent(/^home-site/);
    expect(within(list).getAllByRole("button")).toHaveLength(7);
    expect(screen.getByText(/of 7 online/, { selector: "p" })).toHaveTextContent("2 of 7 online · 25 ms average");
  });

  it("phone: hidden kpis remove the summary, and settings are reachable from the Layout menu", async () => {
    setViewport("phone");
    renderClients(prefs({}, { hidden: ["clients.kpis"] }));
    await screen.findByRole("list", { name: "Clients" });
    expect(screen.queryByText(/of 7 online/, { selector: "p" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Layout" }));
    expect(await screen.findByRole("menuitem", { name: /Widget settings/ })).toBeInTheDocument();
  });

  it("phone: the Clients header keeps Add client", async () => {
    setViewport("phone");
    renderClients();
    await screen.findByRole("list", { name: "Clients" });
    expect(screen.getByRole("button", { name: "Add client" })).toBeInTheDocument();
  });
});
