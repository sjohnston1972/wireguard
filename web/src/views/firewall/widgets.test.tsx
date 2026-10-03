// widgets.test.tsx
//
// Plain English: every Firewall panel is a widget (spec 2026-10-03 §8,
// plan W3). With nothing saved the page is exactly today's; each setting
// changes what it says; hiding and reordering keep the page's shape; the
// rules table's own drag and Alt+Up/Down still move rules, never widgets.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FirewallResponse, PagePrefs, SettingValue } from "@shared/api";
import { renderApp } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { draftData, firewallData, OK } from "./testData";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const at = (base: string, minutesBefore: number) => new Date(Date.parse(base) - minutesBefore * 60_000).toISOString();

/** firewallData with enough drops, captures and ports for the "at most" settings, and a turned-off port. */
function bigData(over: Partial<FirewallResponse> = {}): FirewallResponse {
  const d = firewallData();
  return {
    ...d,
    drops: {
      ...d.drops,
      recent: many(30, (i) => ({ at: at("2026-10-02T11:58:00.000Z", i), src: "10.13.13.4", dst: "192.168.1.10", proto: "tcp", dport: 8000 + i, fromName: "dev-laptop", toName: "192.168.1.10" })),
    },
    captures: many(8, (i) => ({ ...d.captures[0], id: `cap${i}`, requested_at: at("2026-10-02T11:00:00.000Z", i * 10) })),
    forwards: [
      ...d.forwards,
      { id: 2, enabled: 0, name: "Old game server", proto: "udp", public_port: 27015, target_ip: "192.168.1.20", target_port: 27015, allow_from: "", connections: null, lastHit: null },
    ],
    ...over,
  };
}

/** Saved widget settings for the firewall page. */
const ws = (s: Record<string, Record<string, SettingValue>>): PagePrefs => ({ widgets: Object.fromEntries(Object.entries(s).map(([k, v]) => [`firewall.${k}`, { v: 1, s: v }])) });

function renderFw(prefs: PagePrefs | null = null, data: FirewallResponse = firewallData(), routes: Record<string, unknown> = {}) {
  const server = prefsServer(prefs ? { firewall: prefs } : {});
  const r = renderApp("/firewall", { routes: { ...server.routes, "GET /api/v1/firewall": data, ...routes } });
  return { ...r, server };
}

/** Render again in the same test (the previous tree is removed first). */
function cleanupAndRender(p: PagePrefs) {
  cleanup();
  renderFw(p);
}

const region = (name: string | RegExp) => screen.findByRole("region", { name });
const table = () => screen.findByRole("table", { name: "Firewall rules" });
const headers = async () => within(await table()).getAllByRole("columnheader").map((h) => h.textContent);
const bodyRows = async () => Array.from((await table()).querySelectorAll<HTMLElement>("tbody > tr"));
const ruleRow = async (name: string) => (await bodyRows()).find((r) => r.getAttribute("data-rule-name") === name)!;
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const tabNames = (list: HTMLElement) => within(list).getAllByRole("tab").map((t) => t.textContent!.replace(/\s*\(\d+\)$/, ""));

const TITLES = ["Firewall figures", "Firewall rules", "Network zones", "Test specific traffic", "Recent drops", "Published ports", "Packet capture"];
const TODAY_HEADERS = ["Reorder", "#", "Name", "From (source) → to", "to", "To (destination)", "Service / Port", "Action", "Hits (24h)", "Status", "Actions"];

describe("W3.1 frame and defaults", () => {
  it("firewall: every panel is a widget", async () => {
    renderFw();
    for (const t of TITLES) expect(await screen.findByRole("button", { name: `${t} settings` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Layout" })).toBeInTheDocument();
    // The header (policy status, draft bar) is not a widget.
    expect(screen.getByRole("status", { name: "Policy status" }).closest("[data-widget-chrome]")).toBeNull();
  });

  it("on a short window the tabbed column's cog belongs to the tab shown", async () => {
    setViewport([1100, 600]);
    renderFw();
    expect(await screen.findByRole("button", { name: "Recent drops settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Firewall rules settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Firewall figures settings" })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: /zones and simulator/ });
    fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "Zones" }));
    expect(await screen.findByRole("button", { name: "Network zones settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recent drops settings" })).toBeNull();
  });

  it("with no prefs firewall renders today's tiles, columns, ranges and colours", async () => {
    const { fetchMock } = renderFw(null, bigData(), {
      "POST /api/v1/firewall/simulate": { verdict: "deny", matched: null, reason: "", partial: [], limited: null },
      "POST /api/v1/firewall/captures": OK,
    });
    expect(await headers()).toEqual(TODAY_HEADERS);
    // Five tiles, the drops one with its sparkline, change and sub-line, coloured as today.
    for (const g of ["Policy set", "Default action", "Recent drops (24h)", "Published ports", "Packet capture"]) expect(screen.getByRole("group", { name: g })).toBeInTheDocument();
    const drops = screen.getByRole("group", { name: "Recent drops (24h)" });
    expect(within(drops).getByRole("img", { name: /^Drops per hour, last 24 hours/ })).toBeInTheDocument();
    expect(drops).toHaveTextContent("12%");
    expect(drops).toHaveTextContent("From 18 unique sources");
    expect(drops.querySelector(".tile__icon--red")).not.toBeNull();
    expect(drops.querySelector(".tile__value")).not.toHaveAttribute("style");
    expect(screen.getByRole("group", { name: "Policy set" })).toHaveTextContent("2 custom · 3 default");
    // Rules: All rules, comfortable rows, hit sparklines.
    expect(screen.getByRole("tab", { name: "All rules (5)" })).toHaveAttribute("aria-selected", "true");
    expect(await table()).not.toHaveClass("fw-rules--compact");
    expect(within(await ruleRow("Clients to the Azure VNet")).getByRole("img", { name: /^Hits per hour for/ })).toBeInTheDocument();
    // Zones: addresses, rule counts, arrows and the legend.
    const zones = await region("Network zones");
    expect(zones).toHaveTextContent("10.13.13.0/24");
    expect(zones).toHaveTextContent(/\d+ rules?/);
    expect(zones).toHaveTextContent("Tunnel clients to Home LAN");
    expect(zones).toHaveTextContent("Allowed");
    // Drops: all 30, UK time, zone chip and Allow on each.
    const dropsPanel = await region("Recent drops");
    expect(within(dropsPanel).getAllByRole("listitem")).toHaveLength(30);
    expect(dropsPanel).toHaveTextContent("12:58");
    expect(within(dropsPanel).getAllByRole("button", { name: /^Allow / })).toHaveLength(30);
    expect(dropsPanel).toHaveTextContent("Tunnel clients → Home LAN");
    // Ports: the turned-off one too, no connection counts.
    const ports = await region("Published ports");
    expect(ports).toHaveTextContent("Old game server");
    expect(ports).not.toHaveTextContent(/connections/);
    // Capture: wg0, 30 s, the 5 most recent.
    const capture = await region("Packet capture");
    expect(within(capture).getByRole("list", { name: "Recent captures" }).children).toHaveLength(5);
    expect(within(capture).getByLabelText("Seconds")).toHaveValue("30");
    fireEvent.click(within(capture).getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")[0].body).toMatchObject({ iface: "wg0", seconds: 30 });
    // Simulator: Clients → Home, TCP 22.
    const sim = await region("Test specific traffic");
    expect(within(sim).getByLabelText("Port")).toHaveValue("22");
    fireEvent.click(within(sim).getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")[0].body).toEqual({ from: { kind: "zone", value: "clients" }, to: { kind: "zone", value: "home" }, proto: "tcp", port: 22, policy: "live" });
  });
});

describe("W3.2 data", () => {
  it("rules starting tab", async () => {
    renderFw(ws({ rules: { tab: "custom" } }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Custom (2)" })).toHaveAttribute("aria-selected", "true"));
    expect((await bodyRows()).map((r) => r.getAttribute("data-rule-name"))).toEqual(["Web to the test server", "Block old printer", "Default (catch all)"]);
    // The in-panel tabs still change the view.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "All rules (5)" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(6));
  });

  it("last hit and lifetime hits columns", async () => {
    renderFw(ws({ rules: { columns: ["hits", "lastHit", "lifetime"] } }));
    await waitFor(async () => expect(await headers()).toEqual(["Reorder", "#", "Name", "From (source) → to", "to", "To (destination)", "Action", "Hits (24h)", "Last hit", "Lifetime hits", "Status", "Actions"]));
    const first = await ruleRow("Clients to the Azure VNet");
    expect(within(first).getByTestId("last-hit")).toHaveTextContent("1 m ago");
    expect(within(first).getByTestId("lifetime")).toHaveTextContent("100");
    const def = await ruleRow("Default (catch all)");
    expect(within(def).getByTestId("last-hit")).toHaveTextContent("never");
    expect(within(def).getByTestId("lifetime")).toHaveTextContent("42");
    // No columns at all: only the fixed ones.
    cleanupAndRender(ws({ rules: { columns: [] } }));
    await waitFor(async () => expect(await headers()).toEqual(["Reorder", "#", "Name", "From (source) → to", "to", "To (destination)", "Action", "Status", "Actions"]));
  });

  it("simulator starting values prefill the form", async () => {
    const { fetchMock } = renderFw(ws({ simulator: { from: "home", to: "internet", proto: "udp", port: 53 } }), firewallData(), {
      "POST /api/v1/firewall/simulate": { verdict: "deny", matched: null, reason: "", partial: [], limited: null },
    });
    const sim = await region("Test specific traffic");
    await waitFor(() => expect(within(sim).getByLabelText("Port")).toHaveValue("53"));
    fireEvent.click(within(sim).getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")[0].body).toEqual({ from: { kind: "zone", value: "home" }, to: { kind: "zone", value: "internet" }, proto: "udp", port: 53, policy: "live" });
  });

  it("drops show at most", async () => {
    renderFw(ws({ drops: { max: "10" } }), bigData());
    const drops = await region("Recent drops");
    await waitFor(() => expect(within(drops).getAllByRole("listitem")).toHaveLength(10));
    // Below 1400 px the Drops tab counts what it lists.
    cleanup();
    setViewport(1200);
    renderFw(ws({ drops: { max: "10" } }), bigData());
    expect(await screen.findByRole("tab", { name: "Drops (10)" })).toBeInTheDocument();
  });

  it("capture starting interface, seconds and recent count", async () => {
    const { fetchMock } = renderFw(ws({ capture: { iface: "eth0", seconds: 60, recent: 2 } }), bigData(), { "POST /api/v1/firewall/captures": OK });
    const capture = await region("Packet capture");
    await waitFor(() => expect(within(capture).getByRole("list", { name: "Recent captures" }).children).toHaveLength(2));
    expect(within(capture).getByLabelText("Seconds")).toHaveValue("60");
    fireEvent.click(within(capture).getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")[0].body).toMatchObject({ iface: "eth0", seconds: 60 });
  });

  it("kpi tiles", async () => {
    renderFw(ws({ kpis: { tiles: ["drops", "capture"] } }));
    await screen.findByRole("group", { name: "Recent drops (24h)" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Policy set" })).toBeNull());
    expect(screen.queryByRole("group", { name: "Default action" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Published ports" })).toBeNull();
    expect(screen.getByRole("group", { name: "Recent drops (24h)" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Packet capture" })).toBeInTheDocument();
    // The two tiles share the row.
    expect(screen.getByRole("group", { name: "Packet capture" }).parentElement).toHaveClass("fw__kpis--2");
  });
});

describe("W3.3 thresholds and display", () => {
  it("recent drops threshold colours the tile with a word", async () => {
    const cases: [number, string, string][] = [
      [99, "Normal", "green"],
      [100, "High", "amber"],
      [299, "High", "amber"],
      [300, "Very high", "red"],
    ];
    for (const [n, word, tone] of cases) {
      cleanup();
      const d = firewallData();
      renderFw(ws({ kpis: { drops: { warn: 100, bad: 300 } } }), { ...d, drops: { ...d.drops, last24h: n } });
      const tile = await screen.findByRole("group", { name: "Recent drops (24h)" });
      await waitFor(() => expect(tile).toHaveTextContent(word));
      expect(tile.querySelector(`.tile__icon--${tone}`), `${n}`).not.toBeNull();
      if (word === "High") expect(tile).not.toHaveTextContent("Very high");
    }
    // Off (the default): no word, today's red icon.
    cleanup();
    renderFw();
    const tile = await screen.findByRole("group", { name: "Recent drops (24h)" });
    expect(tile).not.toHaveTextContent(/Normal|High/);
  });

  it("kpis sparkline, change and sub-lines off", async () => {
    renderFw(ws({ kpis: { sparkline: false, deltas: false, subLines: false } }));
    const drops = await screen.findByRole("group", { name: "Recent drops (24h)" });
    await waitFor(() => expect(within(drops).queryByRole("img")).toBeNull());
    expect(drops).not.toHaveTextContent("12%");
    expect(drops).not.toHaveTextContent("unique sources");
    expect(screen.getByRole("group", { name: "Policy set" })).not.toHaveTextContent("custom");
  });

  it("drops UTC times", async () => {
    renderFw(ws({ drops: { timeZone: "utc" } }));
    const drops = await region("Recent drops");
    await waitFor(() => expect(drops).toHaveTextContent("11:58"));
    expect(drops).not.toHaveTextContent("12:58");
    expect(drops.querySelector("time")).toHaveAttribute("title", "11:58 UTC");
  });

  it("zone chip and Allow button off", async () => {
    renderFw(ws({ drops: { zoneChip: false, allowButton: false } }));
    const drops = await region("Recent drops");
    await waitFor(() => expect(within(drops).queryByRole("button", { name: /^Allow / })).toBeNull());
    expect(drops).not.toHaveTextContent("Tunnel clients → Home LAN");
    expect(drops).toHaveTextContent("TCP 8080");
  });

  it("zones addresses, counts and arrows off", async () => {
    renderFw(ws({ zones: { addresses: false, ruleCounts: false, arrows: false } }));
    const zones = await region("Network zones");
    await waitFor(() => expect(zones).not.toHaveTextContent("10.13.13.0/24"));
    expect(zones).not.toHaveTextContent(/\d+ rules?\b/);
    expect(zones).not.toHaveTextContent("Tunnel clients to Home LAN");
    expect(zones).not.toHaveTextContent("Allowed");
    expect(within(zones).getByRole("button", { name: /Tunnel clients/ })).toBeInTheDocument();
  });

  it("ports turned-off hidden, connections and last hit shown", async () => {
    renderFw(ws({ ports: { showOff: false, connections: true } }), bigData());
    const ports = await region("Published ports");
    await waitFor(() => expect(ports).not.toHaveTextContent("Old game server"));
    expect(ports).toHaveTextContent("3 connections");
    expect(ports).toHaveTextContent("last hit never");
  });

  it("rules compact density and hits sparkline off", async () => {
    renderFw(ws({ rules: { density: "compact", sparkline: false } }));
    await waitFor(async () => expect(await table()).toHaveClass("fw-rules--compact"));
    expect(within(await ruleRow("Clients to the Azure VNet")).queryByRole("img", { name: /^Hits per hour/ })).toBeNull();
    expect(within(await ruleRow("Clients to the Azure VNet")).getByTestId("hits")).toHaveTextContent("900");
  });
});

describe("W3.4 layout", () => {
  for (const [what, prefs] of [
    ["the figures widget hidden", { layout: { hidden: ["firewall.kpis"] } }],
    ["its Default action tile off", ws({ kpis: { tiles: ["policy", "drops", "ports", "capture"] } })],
  ] as const) {
    it(`with ${what}, the default action can still be changed from its rule row (button and Enter)`, async () => {
      const { fetchMock } = renderFw(prefs as PagePrefs, firewallData(), { "PUT /api/v1/firewall/draft/default": OK });
      await table();
      await waitFor(() => expect(screen.queryByRole("group", { name: "Default action" })).toBeNull());
      const row = screen.getByRole("row", { name: "Default action, always last" });
      fireEvent.click(within(row).getByRole("button", { name: "Change default action to Allow" }));
      await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/default")).toHaveLength(1));
      expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/default")[0].body).toEqual({ action: "allow" });
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
      await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/default")).toHaveLength(2));
    });
  }

  it("with the Default action tile shown, the default row keeps its lock and Enter goes to the tile's Change button", async () => {
    renderFw();
    await table();
    const row = screen.getByRole("row", { name: "Default action, always last" });
    expect(within(row).queryByRole("button", { name: /Change default action/ })).toBeNull();
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(within(screen.getByRole("group", { name: "Default action" })).getByRole("button", { name: "Change default action to Allow" })).toHaveFocus();
  });

  for (const size of ["desktop", "phone"] as const) {
    it(`?action=capture with Packet capture hidden says so, clears the parameter and never takes focus later (${size})`, async () => {
      if (size === "phone") setViewport("phone");
      const server = prefsServer({ firewall: { layout: { hidden: ["firewall.capture"] } } });
      renderApp("/firewall?action=capture", { routes: { ...server.routes, "GET /api/v1/firewall": firewallData() } });
      expect(await screen.findByText("Packet capture is hidden — show it from Layout")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("status", { name: "location", hidden: true }).textContent).toBe("/firewall"));
      expect(screen.queryByRole("dialog", { name: /capture/i })).toBeNull();
      // Shown again later: the form appears but focus stays where it was.
      fireEvent.pointerDown(screen.getByRole("button", { name: "Layout" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Show Packet capture" }));
      await waitFor(() => expect(server.state.pages.firewall.prefs).toEqual({}));
      await new Promise((r) => setTimeout(r, 50));
      if (size === "desktop") {
        const cap = await region("Packet capture");
        expect(cap.contains(document.activeElement)).toBe(false);
      }
      expect(screen.queryByRole("dialog", { name: /capture/i })).toBeNull();
    });
  }

  it("hiding zones gives the simulator the whole bottom row", async () => {
    renderFw({ layout: { hidden: ["firewall.zones"] } });
    const sim = await region("Test specific traffic");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Network zones" })).toBeNull());
    expect(sim.parentElement).toHaveClass("fw__bottom", "fw__bottom--single");
  });

  it("hiding zones and the simulator gives the rules the whole left column", async () => {
    renderFw({ layout: { hidden: ["firewall.zones", "firewall.simulator"] } });
    await table();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Test specific traffic" })).toBeNull());
    expect(document.querySelector(".fw__bottom")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test simulation" })).toBeNull();
  });

  it("swapping zones and simulator", async () => {
    const { server } = renderFw({ layout: { order: { bottom: ["firewall.simulator", "firewall.zones"] } } });
    await waitFor(async () => expect(before(await region("Test specific traffic"), await region("Network zones"))).toBe(true));
    expect((await region("Network zones")).parentElement).toHaveClass("fw__bottom--swapped");
    // Alt+Right on the simulator's move handle puts it back after zones (a widget move, not a rule move).
    const handle = screen.getByRole("button", { name: "Move Test specific traffic" });
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    await waitFor(async () => expect(before(await region("Network zones"), await region("Test specific traffic"))).toBe(true));
    await waitFor(() => expect(server.puts.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(server.puts.at(-1)!.body.prefs.layout?.order?.bottom).toBeUndefined();
  });

  it("hiding drops lets ports and capture share the column", async () => {
    renderFw({ layout: { hidden: ["firewall.drops"] } });
    const ports = await region("Published ports");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Recent drops" })).toBeNull());
    expect(ports.parentElement).toHaveClass("fw__right", "fw__right--no-drops");
    expect(screen.getByRole("region", { name: "Packet capture" })).toBeInTheDocument();
  });

  it("hiding the whole right column widens the left, and the reordered layout renders in the saved order", async () => {
    renderFw({ layout: { hidden: ["firewall.drops", "firewall.ports", "firewall.capture"] } });
    await table();
    await waitFor(() => expect(document.querySelector(".fw__right")).toBeNull());
    expect(document.querySelector(".fw__body")).toHaveClass("fw__body--single");
    cleanup();
    renderFw({ layout: { order: { r2: ["right", "left"] } } });
    await table();
    await waitFor(() => expect(document.querySelector(".fw__body")).toHaveClass("fw__body--reversed"));
    expect(before(document.querySelector(".fw__right")!, document.querySelector(".fw__left")!)).toBe(true);
  });

  it("narrow tabs follow the stack order minus hidden widgets", async () => {
    setViewport(1200);
    renderFw({ layout: { hidden: ["firewall.ports"] } });
    await table();
    await waitFor(() => expect(tabNames(screen.getByRole("tablist", { name: "Drops and capture" }))).toEqual(["Drops", "Capture"]));
    cleanup();
    renderFw({ layout: { hidden: ["firewall.drops"] } });
    await table();
    // The first visible tab is shown.
    const list = await screen.findByRole("tablist", { name: "Published ports and capture" });
    expect(tabNames(list)).toEqual(["Published ports", "Capture"]);
    expect(within(list).getByRole("tab", { name: "Published ports" })).toHaveAttribute("aria-selected", "true");
  });

  it("short tabs include zones and simulator only when visible", async () => {
    setViewport([1100, 600]);
    renderFw({ layout: { hidden: ["firewall.zones"] } });
    await table();
    await waitFor(() => expect(tabNames(screen.getByRole("tablist", { name: "Drops, published ports, capture and simulator" }))).toEqual(["Drops", "Ports", "Capture", "Test"]));
    cleanup();
    renderFw({ layout: { order: { bottom: ["firewall.simulator", "firewall.zones"] } } });
    await table();
    await waitFor(() => expect(tabNames(screen.getByRole("tablist", { name: /simulator and zones$/ }))).toEqual(["Drops", "Ports", "Capture", "Test", "Zones"]));
    cleanup();
    // Only zones and the simulator left: they still make the right column.
    renderFw({ layout: { hidden: ["firewall.drops", "firewall.ports", "firewall.capture"] } });
    await table();
    await waitFor(() => expect(tabNames(screen.getByRole("tablist", { name: "Zones and simulator" }))).toEqual(["Zones", "Test"]));
  });

  it("dragging a rule still sends one draft move and moves no widget", async () => {
    const { fetchMock, server } = renderFw(null, firewallData({ draft: draftData() }), { "POST /api/v1/firewall/draft/rules/1/move": OK });
    const moves = () => fetchMock!.calls.filter((c) => c.method === "POST" && /\/firewall\/draft\/rules\/\d+\/move$/.test(c.url));
    await screen.findByRole("button", { name: "Move Network zones" });
    const handle = within(await ruleRow("Clients to the Azure VNet")).getByTitle("Drag to reorder Clients to the Azure VNet");
    const target = await ruleRow("Web to the test server");
    const zonesBefore = before(await region("Network zones"), await region("Test specific traffic"));
    fireEvent.dragStart(handle);
    fireEvent.dragEnter(target);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    // The same drag let go over a widget is not a widget move either.
    fireEvent.drop(await region("Test specific traffic"));
    fireEvent.dragEnd(handle);
    await waitFor(() => expect(moves()).toHaveLength(1));
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(moves()).toHaveLength(1);
    expect(moves()[0].body).toEqual({ to: 2 });
    expect(server.puts).toHaveLength(0);
    expect(before(await region("Network zones"), await region("Test specific traffic"))).toBe(zonesBefore);
  });

  it("Alt+ArrowDown on a rule moves the rule; Alt+ArrowRight on a widget handle moves the widget", async () => {
    const { fetchMock, server } = renderFw(null, firewallData(), { "POST /api/v1/firewall/draft/rules/2/move": OK });
    const moves = () => fetchMock!.calls.filter((c) => c.method === "POST" && /\/move$/.test(c.url));
    const r2 = await ruleRow("Clients to the internet (full tunnel)");
    act(() => r2.focus());
    fireEvent.keyDown(r2, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(r2, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0].body).toEqual({ dir: "down" });
    const handle = await screen.findByRole("button", { name: "Move Network zones" });
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(server.puts).toHaveLength(1), { timeout: 3000 });
    expect(server.puts[0].body.prefs.layout?.order?.bottom).toEqual(["firewall.simulator", "firewall.zones"]);
    expect(moves()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Network zones" }));
  });

  it("rules cannot be hidden", async () => {
    renderFw({ layout: { hidden: ["firewall.rules", "firewall.zones"] } });
    expect(await table()).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Firewall rules settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Firewall rules settings" });
    expect(within(dialog).queryByRole("button", { name: "Hide widget" })).toBeNull();
    // Rules sit in the left stack: no move controls either.
    expect(screen.queryByRole("button", { name: "Move Firewall rules" })).toBeNull();
  });

  it("the two columns swap as one: by a column's handle (Alt+Arrow) and from any member's cog", async () => {
    const { server } = renderFw();
    await table();
    // One handle per column, on its top widget.
    const handle = await screen.findByRole("button", { name: "Move Firewall rules column" });
    expect(screen.getByRole("button", { name: "Move Recent drops column" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move Published ports/ })).toBeNull();
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(document.querySelector(".fw__body")).toHaveClass("fw__body--reversed"));
    expect(before(document.querySelector(".fw__right")!, document.querySelector(".fw__left")!)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Firewall rules column" }));
    // From the capture widget's cog: the right column goes back to the right.
    fireEvent.click(screen.getByRole("button", { name: "Packet capture settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Packet capture settings" });
    expect(within(dialog).getByRole("button", { name: "Move column left" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move column right" }));
    await waitFor(() => expect(document.querySelector(".fw__body")).not.toHaveClass("fw__body--reversed"));
    await waitFor(() => expect(server.puts.length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("the tabbed right column carries its column's handle whichever tab is shown", async () => {
    setViewport(1200);
    renderFw();
    await table();
    expect(await screen.findByRole("button", { name: "Move Recent drops column" })).toBeInTheDocument();
    fireEvent.mouseDown(within(screen.getByRole("tablist", { name: "Drops, published ports and capture" })).getByRole("tab", { name: "Capture" }));
    expect(await screen.findByRole("button", { name: "Move Packet capture column" })).toBeInTheDocument();
  });

  it("hiding a widget from its cog removes it and the Layout menu brings it back", async () => {
    const { server } = renderFw();
    fireEvent.click(await screen.findByRole("button", { name: "Published ports settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Published ports settings" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Hide widget" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide widget" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Published ports" })).toBeNull());
    await waitFor(() => expect(server.puts).toHaveLength(1), { timeout: 3000 });
    expect(server.puts[0].body.prefs.layout?.hidden).toEqual(["firewall.ports"]);
  });
});

describe("W3.5 phone", () => {
  it("phone: hidden drops, ports or capture remove their button; the lights follow kpis tiles", async () => {
    setViewport("phone");
    renderFw({ layout: { hidden: ["firewall.drops", "firewall.ports", "firewall.capture"] }, ...ws({ kpis: { tiles: ["policy"] } }) });
    const lights = await screen.findByRole("list", { name: "Firewall at a glance" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Drops" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Published ports" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Capture" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test traffic" })).toBeInTheDocument();
    expect(within(lights).getAllByRole("listitem").map((l) => l.querySelector(".fw-ph__lbl")!.textContent)).toEqual(["Applied", "Rules"]);
    expect(screen.getByRole("button", { name: "Layout" })).toBeInTheDocument();
  });

  it("phone: today's buttons and lights with no prefs; settings apply inside the sheets", async () => {
    setViewport("phone");
    renderFw(ws({ drops: { allowButton: false, timeZone: "utc" }, kpis: { drops: { warn: 100, bad: null } } }));
    const lights = await screen.findByRole("list", { name: "Firewall at a glance" });
    expect(within(lights).getAllByRole("listitem")).toHaveLength(4);
    await waitFor(() => expect(lights).toHaveTextContent(/Recent drops.*342 in 24 h · High/));
    expect(lights.querySelector(".fw-ph__dot--amber")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drops" }));
    const sheet = await screen.findByRole("dialog", { name: "Recent drops" });
    expect(within(sheet).queryByRole("button", { name: /^Allow / })).toBeNull();
    expect(sheet).toHaveTextContent("11:58");
  });

  it("phone: a hidden simulator removes Test traffic", async () => {
    setViewport("phone");
    renderFw({ layout: { hidden: ["firewall.simulator"] } });
    await screen.findByRole("list", { name: "Firewall at a glance" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Test traffic" })).toBeNull());
    expect(screen.getByRole("button", { name: "Drops" })).toBeInTheDocument();
  });
});
