import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { firewallData, OK } from "./testData";

// Each test renders the whole page (many Radix controls); jsdom is slow at that under load.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// hidden: an open modal marks the rest of the page (and this probe) aria-hidden.
const location = () => screen.getByRole("status", { name: "location", hidden: true }).textContent;

describe("rule drawer", () => {
  it("/firewall/rules/:id opens the rule; saving sends only the changed fields to the draft", async () => {
    const { fetchMock } = renderApp("/firewall/rules/3", { routes: { "GET /api/v1/firewall": firewallData(), "PUT /api/v1/firewall/draft/rules/3": OK } });
    const dialog = await screen.findByRole("dialog", { name: "Web to the test server" });
    expect(within(dialog).getByLabelText("Ports")).toHaveValue("443");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Web to the test servers" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to draft" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/rules/3")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/rules/3")[0].body).toEqual({ name: "Web to the test servers" });
    await waitFor(() => expect(location()).toBe("/firewall"), { timeout: 5000 });
  });

  it("clicking a rule's row opens its drawer and Escape closes it", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const table = await screen.findByRole("table", { name: "Firewall rules" });
    fireEvent.click(within(table).getByText("Block old printer"));
    await waitFor(() => expect(location()).toBe("/firewall/rules/4"), { timeout: 5000 });
    const dialog = await screen.findByRole("dialog", { name: "Block old printer" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(location()).toBe("/firewall"), { timeout: 5000 });
  });

  it.each(["proto", "enabled", "log", "something_new"])("a server error for %s, a field the form does not show, is shown as a form error", async (field) => {
    const message = `The server did not like ${field}.`;
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData(),
        "POST /api/v1/firewall/draft/rules": { status: 400, json: { error: { code: "bad_input", message, field } } },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add rule" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clients to the internet" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to draft" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Clients to the internet");
  });

  it("a server error for ports while the protocol has no ports is shown as a form error", async () => {
    const message = "Ports only make sense for TCP or UDP.";
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData(),
        "POST /api/v1/firewall/draft/rules": { status: 400, json: { error: { code: "bad_input", message, field: "ports" } } },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add rule" });
    expect(within(dialog).queryByLabelText("Ports")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Anything" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to draft" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
  });

  it("Add rule posts the whole rule to the draft; a field error shows at the field and keeps the input", async () => {
    let tries = 0;
    const { fetchMock } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData(),
        "POST /api/v1/firewall/draft/rules": () =>
          ++tries === 1 ? { status: 400, json: { error: { code: "bad_input", message: "That name is already used.", field: "name" } } } : OK,
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add rule" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clients to the internet" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to draft" }));
    expect(await within(dialog).findByText("That name is already used.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Clients to the internet");
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/rules")[0].body).toEqual({
      name: "Clients to the internet",
      from: { kind: "zone", value: "clients" },
      to: { kind: "zone", value: "internet" },
      proto: "any",
      action: "allow",
      enabled: true,
      log: false,
    });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Clients out" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 5000 });
  });

  it("the hit history tab reads the rule's counter history", async () => {
    const { fetchMock } = renderApp("/firewall/rules/1?tab=history", {
      routes: {
        "GET /api/v1/firewall": firewallData(),
        "GET /api/v1/history": { range: "24h", step: 3600, from: "", to: "", latest: null, points: [{ t: "2026-10-02T10:00:00.000Z", packets: 120, bytes: 9000 }, { t: "2026-10-02T11:00:00.000Z", packets: 30, bytes: 2000 }] },
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "Clients to the Azure VNet" });
    expect(await within(dialog).findByText("150 packets in the last 24h")).toBeInTheDocument();
    expect(fetchMock!.calls.some((c) => c.url === "/api/v1/history?scope=rule&id=r1&range=24h")).toBe(true);
  });

  it("an unknown rule id says so", async () => {
    renderApp("/firewall/rules/99", { routes: { "GET /api/v1/firewall": firewallData() } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("No rule 99");
  });
});
