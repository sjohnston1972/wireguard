import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { draftData, firewallData, OK } from "./testData";

// Each test renders the whole page (many Radix controls); jsdom is slow at that under load.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const region = (name: string | RegExp) => screen.findByRole("region", { name });
const location = () => screen.getByRole("status", { name: "location" }).textContent;

describe("firewall panels", () => {
  it("Allow on a drop calls from-drop", async () => {
    const { fetchMock } = renderApp("/firewall", {
      routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/draft/from-drop": { ok: true, message: "Added an allow rule to the draft." } },
    });
    const drops = await region("Recent drops");
    expect(drops).toHaveTextContent("TCP 8080");
    expect(drops).toHaveTextContent("10.13.13.4");
    fireEvent.click(within(drops).getByRole("button", { name: "Allow TCP 8080 from dev-laptop to 192.168.1.10" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/from-drop")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/from-drop")[0].body).toEqual({ src: "10.13.13.4", dst: "192.168.1.10", proto: "tcp", dport: 8080 });
    expect(await screen.findByText("Added an allow rule to the draft.")).toBeInTheDocument();
  });

  it("the simulator sends policy draft when Draft is chosen and shows partial and limited notes", async () => {
    const { fetchMock } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData({ draft: draftData() }),
        "POST /api/v1/firewall/simulate": {
          verdict: "allow",
          matched: { id: 9, name: "SSH to workloads", place: 6 },
          reason: "Rule 6 allows it.",
          partial: [{ id: 3, name: "Web to the test server", place: 3 }],
          limited: "Replies to allowed connections are not simulated.",
        },
      },
    });
    const sim = await region("Test specific traffic");
    fireEvent.change(within(sim).getByLabelText("Port"), { target: { value: "22" } });
    fireEvent.click(within(sim).getByRole("radio", { name: "Draft" }));
    fireEvent.click(within(sim).getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")[0].body).toEqual({
      from: { kind: "zone", value: "clients" },
      to: { kind: "zone", value: "home" },
      proto: "tcp",
      port: 22,
      policy: "draft",
    });
    const result = await within(sim).findByRole("status", { name: "Simulation result" });
    expect(result).toHaveTextContent("Would be ALLOWED");
    expect(result).toHaveTextContent("SSH to workloads (rule 6)");
    expect(result).toHaveTextContent(/partial.*Web to the test server \(rule 3\)/i);
    expect(result).toHaveTextContent("Limited simulation: Replies to allowed connections are not simulated.");
  });

  it("without a draft the simulator has no Live/Draft switch and tests the live rules", async () => {
    const { fetchMock } = renderApp("/firewall", {
      routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/simulate": { verdict: "deny", matched: null, reason: "No rule matched.", partial: [], limited: null } },
    });
    const sim = await region("Test specific traffic");
    expect(within(sim).queryByRole("radio", { name: "Draft" })).toBeNull();
    fireEvent.click(within(sim).getByRole("button", { name: "Simulate" }));
    const result = await within(sim).findByRole("status", { name: "Simulation result" });
    expect(result).toHaveTextContent("Would be DENIED");
    expect(result).toHaveTextContent("the default action");
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/simulate")[0].body).toMatchObject({ policy: "live" });
  });

  it("clicking a zone filters the rules", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const zones = await region("Network zones");
    const workloads = within(zones).getByRole("button", { name: /Workloads subnet/ });
    fireEvent.click(workloads);
    expect(workloads).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "Firewall rules" });
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1).map((r) => r.getAttribute("data-rule-name"))).toEqual(["Workloads to the internet (updates)"]));
    fireEvent.click(workloads);
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(7));
  });

  it("published port create shows Azure's warning", async () => {
    const warning = "Saved, but Azure did not open the port: the network security group is locked.";
    const { fetchMock } = renderApp("/firewall", {
      routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/forwards": { ok: true, message: "Published TCP 8443 → 10.50.2.4:443.", warning } },
    });
    const ports = await region("Published ports");
    fireEvent.click(within(ports).getByRole("button", { name: "Add published port" }));
    const dialog = await screen.findByRole("dialog", { name: "Add published port" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Test web" } });
    fireEvent.change(within(dialog).getByLabelText("Public port"), { target: { value: "8443" } });
    fireEvent.change(within(dialog).getByLabelText("Target address"), { target: { value: "10.50.2.4" } });
    fireEvent.change(within(dialog).getByLabelText("Target port"), { target: { value: "443" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/forwards")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/forwards")[0].body).toEqual({ name: "Test web", proto: "tcp", public_port: 8443, target_ip: "10.50.2.4", target_port: 443, allow_from: "" });
    expect(await screen.findByText(warning)).toBeInTheDocument();
  });

  it("a published port's field error shows at the field and keeps the input", async () => {
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData(),
        "POST /api/v1/firewall/forwards": { status: 400, json: { error: { code: "bad_input", message: "Port 51820 is WireGuard; pick another public port.", field: "public_port" } } },
      },
    });
    fireEvent.click(within(await region("Published ports")).getByRole("button", { name: "Add published port" }));
    const dialog = await screen.findByRole("dialog", { name: "Add published port" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clash" } });
    fireEvent.change(within(dialog).getByLabelText("Public port"), { target: { value: "51820" } });
    fireEvent.change(within(dialog).getByLabelText("Target address"), { target: { value: "10.50.2.4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await within(dialog).findByText("Port 51820 is WireGuard; pick another public port.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Clash");
  });

  it("?action=capture focuses the capture form", async () => {
    renderApp("/firewall?action=capture", { routes: { "GET /api/v1/firewall": firewallData() } });
    const capture = await region("Packet capture");
    await waitFor(() => expect(capture.contains(document.activeElement)).toBe(true));
    await waitFor(() => expect(location()).toBe("/firewall"), { timeout: 5000 });
  });

  it("Start capture sends the capture form", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/captures": { ok: true, message: "Capture requested." } } });
    const capture = await region("Packet capture");
    fireEvent.change(within(capture).getByLabelText("Filter"), { target: { value: "port 53" } });
    fireEvent.click(within(capture).getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/captures")[0].body).toEqual({ iface: "wg0", who: "any", seconds: 30, filter: "port 53" });
    expect(within(capture).getByRole("link", { name: /download/i })).toHaveAttribute("href", "/captures/cap1");
  });

  it("?action=add-rule opens the rule drawer", async () => {
    renderApp("/firewall?action=add-rule", { routes: { "GET /api/v1/firewall": firewallData() } });
    const dialog = await screen.findByRole("dialog", { name: "Add rule" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).toBe("/firewall");
  });

  it("changing the default action edits the draft", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData(), "PUT /api/v1/firewall/draft/default": OK } });
    const tile = await screen.findByRole("group", { name: "Default action" });
    expect(tile).toHaveTextContent("Deny");
    fireEvent.click(within(tile).getByRole("button", { name: "Change default action to Allow" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/default")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/default")[0].body).toEqual({ action: "allow" });
  });

  it("the KPI tiles count rules, drops and published ports", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    expect(await screen.findByRole("group", { name: "Policy set" })).toHaveTextContent(/5 rules.*2 custom · 3 default/);
    const drops = screen.getByRole("group", { name: "Recent drops (24h)" });
    expect(drops).toHaveTextContent("342");
    expect(drops).toHaveTextContent("From 18 unique sources");
    expect(drops).toHaveTextContent(/up\s*12%/);
    expect(screen.getByRole("group", { name: "Published ports" })).toHaveTextContent("1 active");
    expect(screen.getByRole("group", { name: "Packet capture" })).toHaveTextContent("Ready");
  });
});
