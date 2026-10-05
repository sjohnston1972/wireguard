// labs.test.tsx
//
// Plain English: the Firewall's Labs zone (Labs spec section 7.6). It is in the
// zone list, the rule pickers and the simulator, and the "Clients to labs" rule
// the Worker proposes on an existing install arrives as an unpublished change
// in the draft bar, never as a live rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DraftRuleRow, FirewallResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { draftData, firewallData } from "./testData";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const region = (name: string | RegExp) => screen.findByRole("region", { name });
const LABS = { zone: "labs" as const, label: "Labs", v4: ["10.64.0.0/13"], v6: [], negate: false };
/** The live zones with Labs before Internet, as the Worker lists them. */
const withLabs = (): FirewallResponse["zones"] => {
  const z = firewallData().zones;
  return [...z.slice(0, -1), LABS, z[z.length - 1]];
};
const PROPOSED: DraftRuleRow = {
  id: 9,
  liveId: null,
  position: 210,
  enabled: 1,
  name: "Clients to labs",
  src_kind: "zone",
  src_value: "clients",
  dst_kind: "zone",
  dst_value: "labs",
  proto: "any",
  ports: "",
  action: "allow",
  log: 0,
  place: 6,
  fromLabel: "Tunnel clients",
  toLabel: "Labs",
  service: "Any",
  problem: null,
  mark: "added",
};

describe("Firewall: the Labs zone", () => {
  it("Labs zone in the zone list, between Workloads and Internet, with its pool", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ zones: withLabs() }) } });
    const zones = await region("Network zones");
    const cards = within(zones).getAllByRole("button").filter((c) => c.classList.contains("fw-zones__card"));
    expect(cards.map((c) => c.querySelector(".fw-zones__label")?.textContent)).toEqual(["Tunnel clients", "Home LAN", "Azure VNet", "Workloads subnet", "Labs", "Internet"]);
    expect(within(zones).getByRole("button", { name: /Labs/ })).toHaveTextContent("10.64.0.0/13");
  });

  it("clicking the Labs zone filters the rules to those that name it", async () => {
    const rule = { ...firewallData().rules[0], id: 6, name: "Clients to labs", dst_value: "labs", toLabel: "Labs", place: 6 };
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ zones: withLabs(), rules: [...firewallData().rules, rule] }) } });
    const zones = await region("Network zones");
    fireEvent.click(within(zones).getByRole("button", { name: /Labs/ }));
    const table = screen.getByRole("table", { name: "Firewall rules" });
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1).map((r) => r.getAttribute("data-rule-name"))).toEqual(["Clients to labs"]));
  });

  it("Labs is a choice in the rule pickers and the simulator", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ zones: withLabs() }) } });
    const sim = await region("Test specific traffic");
    fireEvent.click(within(sim).getByRole("combobox", { name: "To (destination)" }));
    expect(await screen.findByRole("option", { name: "Labs" })).toBeInTheDocument();
  });

  it("the proposed Clients to labs draft rule shows in the draft bar", async () => {
    const draft = draftData({
      rules: draftData().rules.filter((r) => r.mark !== "added").concat(PROPOSED),
      diff: { added: [{ id: 9, name: "Clients to labs", place: 6 }], removed: [], changed: [], moved: [], defaultChanged: null },
      changes: 1,
    });
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ zones: withLabs(), draft }) } });
    const bar = await region("Unpublished changes");
    expect(bar).toHaveTextContent("1 unpublished change");
    const table = await screen.findByRole("table", { name: "Firewall rules" });
    const row = await waitFor(() => {
      const r = within(table).getAllByRole("row").find((x) => x.getAttribute("data-rule-name") === "Clients to labs");
      if (!r) throw new Error("no proposed row yet");
      return r;
    });
    expect(row).toHaveTextContent("Labs");
  });
});
