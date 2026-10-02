import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { NOW_MS, overview, routes, vmHistory } from "./testData";

const metrics = () => screen.findByRole("region", { name: "Key metrics" });
const topology = () => screen.findByRole("region", { name: "Live topology" });

describe("Overview key metrics", () => {
  it("the range switch refetches vm history with that range", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("running")) });
    const m = await metrics();
    await waitFor(() => expect(r.fetchMock!.calls.some((c) => c.url.includes("/history?scope=vm&range=1h"))).toBe(true));
    const range = within(m).getByRole("radiogroup", { name: "Metrics range" });
    expect(within(range).getByRole("radio", { name: "Live" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(range).getByRole("radio", { name: "24h" }));
    await waitFor(() => expect(r.fetchMock!.calls.some((c) => c.url.includes("/history?scope=vm&range=24h"))).toBe(true));
    await user.click(within(range).getByRole("radio", { name: "30d" }));
    await waitFor(() => expect(r.fetchMock!.calls.some((c) => c.url.includes("/history?scope=vm&range=30d"))).toBe(true));
    expect(m).toHaveTextContent("last 30 days");
  });

  it("destroyed with no history shows no data, not zeros", async () => {
    renderApp("/", { routes: routes(overview("destroyed")) });
    const m = await metrics();
    await waitFor(() => expect(within(m).getByRole("group", { name: "Availability" })).toHaveTextContent("no data"));
    for (const name of ["Connected clients", "Latency (avg)", "DNS status", "Heartbeat (VM)", "Session cost", "Availability"]) {
      const tile = within(m).getByRole("group", { name });
      expect(tile).toHaveTextContent("no data");
      expect(tile).not.toHaveTextContent(/\b0\s*\/|(^|\D)0%|100%|£0\.00|\b0 ms|Healthy|Online/);
    }
    // The topology does not call anything healthy either.
    expect(await topology()).not.toHaveTextContent("Healthy");
  });

  it("history with points gives the range's figures", async () => {
    const user = userEvent.setup();
    const points = [0, 1, 2].map((i) => ({ t: new Date(NOW_MS - (3 - i) * 300_000).toISOString(), expected: 5, received: 5, load1: 0.1, rx_rate: 100, tx_rate: 50, rx_rate_max: 200, tx_rate_max: 80, peers_online: i + 1, dns_up: 1 }));
    renderApp("/", {
      routes: routes(overview("running"), { "GET /api/v1/history": vmHistory("24h", { points, latest: points[2].t, availability: { expected: 15, received: 15, pct: 100 } }) }),
    });
    const m = await metrics();
    await user.click(within(m).getByRole("radio", { name: "24h" }));
    await waitFor(() => expect(within(m).getByRole("group", { name: "Availability" })).toHaveTextContent("100%"));
    expect(within(m).getByRole("group", { name: "Connected clients" })).toHaveTextContent("3 / 3");
    expect(within(m).getByRole("group", { name: "Connected clients" })).toHaveTextContent("peak");
  });

  it("a stale heartbeat greys the tiles and shows their age", async () => {
    const o = overview("running", { derived: { heartbeatStale: true }, snapshot: { last_agent_at: new Date(NOW_MS - 5 * 60_000).toISOString() } });
    renderApp("/", { routes: routes(o) });
    const m = await metrics();
    const tiles = within(m).getByTestId("ov-tiles");
    expect(tiles).toHaveAttribute("data-stale", "true");
    expect(within(m).getByRole("group", { name: "Heartbeat (VM)" })).toHaveTextContent(/Late/);
    expect(within(m).getByRole("group", { name: "Heartbeat (VM)" })).toHaveTextContent(/5 m ago/);
    expect(m).toHaveTextContent(/stale/i);
  });

  it("topology nodes take degraded and down colours with words", async () => {
    const o = overview("running", { derived: { heartbeatStale: true, clientsOnline: 0 }, snapshot: { azure: { checked_at: new Date(NOW_MS).toISOString(), resource_group: "rg-wg", exists: true, resources: [], error: "Azure said 429" } } });
    const r = renderApp("/", { routes: routes(o) });
    const t = await topology();
    const endpoint = within(t).getByRole("button", { name: /^WireGuard endpoint/ });
    expect(endpoint).toHaveAttribute("data-status", "down");
    expect(endpoint).toHaveTextContent("Down");
    const azure = within(t).getByRole("button", { name: /^Microsoft Azure/ });
    expect(azure).toHaveAttribute("data-status", "degraded");
    expect(azure).toHaveTextContent("Degraded");
    expect(within(t).getByText("Down", { selector: ".pill *, .pill" })).toBeInTheDocument();
    r.unmount();

    renderApp("/", { routes: routes(overview("running", { derived: { clientsOnline: 0 } })) });
    const t2 = await topology();
    const clients = within(t2).getByRole("button", { name: /^Clients/ });
    expect(clients).toHaveAttribute("data-status", "degraded");
    expect(clients).toHaveTextContent("Degraded");
    expect(within(t2).getByRole("button", { name: /^WireGuard endpoint/ })).toHaveAttribute("data-status", "healthy");
  });

  it("the endpoint opens the SSH drawer; the password is fetched only on press", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("running"), { "GET /api/v1/ssh-password": { password: "not-a-real-one" }, "POST /api/v1/allow-ssh": { ok: true, message: "Allowed." } }) });
    const t = await topology();
    await user.click(within(t).getByRole("button", { name: /^WireGuard endpoint/ }));
    const d = await screen.findByRole("dialog", { name: "SSH to the VM" });
    expect(d).toHaveTextContent("198.51.100.7");
    expect(r.fetchMock!.callsTo("GET", "/api/v1/ssh-password")).toHaveLength(0);
    await user.click(within(d).getByRole("button", { name: "Show password" }));
    expect(await within(d).findByText("not-a-real-one")).toBeInTheDocument();
    expect(r.fetchMock!.callsTo("GET", "/api/v1/ssh-password")).toHaveLength(1);
    await user.click(within(d).getByRole("button", { name: "Allow SSH from this address" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/allow-ssh")).toHaveLength(1));
  });

  it("Azure opens what is in Azure right now, with its age, and Check Azure reconciles", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("running"), { "POST /api/v1/reconcile": { ok: true, message: "Checked." } }) });
    const t = await topology();
    await user.click(within(t).getByRole("button", { name: /^Microsoft Azure/ }));
    const d = await screen.findByRole("dialog", { name: "In Azure right now" });
    expect(d).toHaveTextContent("vm-wg");
    expect(d).toHaveTextContent(/checked 2 m ago/);
    await user.click(within(d).getByRole("button", { name: "Check Azure now" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/reconcile")).toHaveLength(1));
  });

  it("Clients opens the Clients view", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { ...routes(overview("running")), "GET /api/v1/clients": { clients: [] } } });
    const t = await topology();
    await user.click(within(t).getByRole("button", { name: /^Clients/ }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/clients$/));
  });
});
