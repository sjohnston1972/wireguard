import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { firewallData, OK } from "./testData";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const table = () => screen.findByRole("table", { name: "Firewall rules" });
/** Body rows of the rules table (the header row left out). */
async function bodyRows() {
  const t = await table();
  return within(t).getAllByRole("row").slice(1);
}
const names = async () => (await bodyRows()).map((r) => r.getAttribute("data-rule-name"));

describe("rules table", () => {
  it("filter tabs use starter for Default and Custom", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    await table();
    expect(await names()).toEqual([
      "Clients to the Azure VNet",
      "Clients to the internet (full tunnel)",
      "Web to the test server",
      "Block old printer",
      "Workloads to the internet (updates)",
      "Default (catch all)",
    ]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Custom (2)" }));
    await waitFor(async () => expect(await names()).toEqual(["Web to the test server", "Block old printer", "Default (catch all)"]));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Default (3)" }));
    await waitFor(async () =>
      expect(await names()).toEqual(["Clients to the Azure VNet", "Clients to the internet (full tunnel)", "Workloads to the internet (updates)", "Default (catch all)"]),
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Disabled (1)" }));
    await waitFor(async () => expect(await names()).toEqual(["Block old printer"]));
  });

  it("the default row is last and has no toggle or handle", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const rows = await bodyRows();
    const last = rows[rows.length - 1];
    expect(last).toHaveTextContent("Default (catch all)");
    expect(last).toHaveTextContent("Always on");
    expect(within(last).queryByRole("switch")).toBeNull();
    expect(within(last).queryByTitle(/drag to reorder/i)).toBeNull();
    expect(last).not.toHaveAttribute("draggable");
    // Every other rule has both.
    expect(within(rows[0]).getByRole("switch")).toBeInTheDocument();
    expect(within(rows[0]).getByTitle(/drag to reorder/i)).toBeInTheDocument();
  });

  it("toggling a rule sends PUT draft rule enabled", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData(), "PUT /api/v1/firewall/draft/rules/1": OK } });
    await table();
    fireEvent.click(screen.getByRole("switch", { name: "Enabled: Clients to the Azure VNet" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/rules/1")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/firewall/draft/rules/1")[0].body).toEqual({ enabled: false });
  });

  it("hits show no data when hits24h is null", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const rows = await bodyRows();
    const printer = rows.find((r) => r.getAttribute("data-rule-name") === "Block old printer")!;
    const hits = within(printer).getByTestId("hits");
    expect(hits).toHaveTextContent("no data");
    expect(hits).not.toHaveTextContent(/\b0\b/);
    const first = within(rows[0]).getByTestId("hits");
    expect(first).toHaveTextContent("900");
  });

  it("shows the draft's rules with their marks when a draft exists", async () => {
    const { draftData } = await import("./testData");
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ draft: draftData() }) } });
    const rows = await bodyRows();
    const added = rows.find((r) => r.getAttribute("data-rule-name") === "SSH to workloads")!;
    expect(added).toHaveTextContent("Added");
    const changed = rows.find((r) => r.getAttribute("data-rule-name") === "Web to the test server")!;
    expect(changed).toHaveTextContent("Changed");
    expect(rows[rows.length - 1]).toHaveTextContent("Default (catch all)");
  });
});
