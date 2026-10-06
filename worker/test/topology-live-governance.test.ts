// topology-live-governance.test.ts: T3.6 governance and monitoring (lab topology plan T3.6). Live derivation of Log
// Analytics, action groups, metric and activity-log alerts, data collection rules and Bastion from Resource Graph row
// fixtures (fixtures/topology/live/governance.json); what the one query cannot list (policy, roles, management groups,
// Entra principals, locks, budgets, diagnostic settings) is planned-only and "not listed", never "not deployed"; and
// the round trip of the family's labs (1, 2, 3, 4, 18, 20, 21, 44).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { diffGraphs } from "../../shared/topology/diff";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, plannedOf, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/governance.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az104-18-monitor"));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("live governance and monitoring (T3.6)", () => {
  it("Log Analytics shows its retention and daily cap", () => {
    expect(byLabel(g, "log-lab")).toMatchObject({ kind: "logAnalytics", props: { retentionDays: 30, dailyCapGb: 0.05 } });
  });

  it("a metric alert watches its scope and notifies its action group; an activity-log alert watches the group", () => {
    expect(edgesBetween(g, "alert-vm-cpu-high", "vm-monitor")).toMatchObject([{ kind: "dependency", label: "alert" }]);
    expect(edgesBetween(g, "alert-vm-cpu-high", "ag-lab")).toMatchObject([{ kind: "dependency", label: "notifies" }]);
    expect(edgesBetween(g, "alert-vm-restart", "rg-lab-az104-18-monitor")).toMatchObject([{ label: "alert" }]);
    expect(edgesBetween(g, "alert-vm-restart", "ag-lab")).toMatchObject([{ label: "notifies" }]);
    expect(byLabel(g, "ag-lab").kind).toBe("monitor");
  });

  it("a data collection rule sends to its workspace; traffic analytics' own rule and endpoint are made by Azure", () => {
    expect(edgesBetween(g, "dcr-vm-linux", "log-lab")).toMatchObject([{ kind: "dependency", label: "sends to" }]);
    const nwta = g.nodes.filter((n) => n.label.startsWith("NWTA-"));
    expect(nwta).toHaveLength(2);
    expect(nwta.every((n) => n.madeBy === "azure")).toBe(true);
  });

  it("Bastion sits in AzureBastionSubnet with its SKU (public IP folded); a Developer Bastion sits in its VNet", () => {
    const b = byLabel(g, "bas-hub");
    expect(parentLabel(g, b)).toBe("AzureBastionSubnet");
    expect(b.props).toMatchObject({ sku: "Basic" });
    expect(b.folded?.map((f) => f.label)).toEqual(["pip-bastion"]);
    expect(parentLabel(g, byLabel(g, "bas-dev"))).toBe("vnet-lab");
  });

  it("planned-only kinds are 'not listed', never 'not deployed' (labs 1, 2, 3, 20 against an empty live graph)", () => {
    for (const id of ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone"]) {
      const planned = plannedOf(id);
      const { status } = diffGraphs(planned, liveGraph([], liveCtxFor(id)));
      for (const n of planned.nodes.filter((x) => ["policy", "role", "managementGroup", "entraPrincipal"].includes(x.kind))) expect(status[n.key], `${id} ${n.label}`).toBe("unlisted");
    }
  });

  it("the deny check passes; no workspace or rule ids leak; nothing is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(JSON.stringify(g)).not.toMatch(/dddddddd-4444|dcr-0123456789/);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the governance and monitoring labs", () => {
  for (const id of ["az104-01-identity", "az104-02-policy", "az104-04-cost", "az104-18-monitor", "az305-20-landing-zone", "az305-21-monitoring-scale", "az700-44-flow-logs-bastion"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }

  it("az104-03-mgmt-groups: only its empty resource group is missing (the query has no group rows: T0's diff, reported to the integrator)", () => {
    const r = roundTrip("az104-03-mgmt-groups");
    expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: ["microsoft.resources/resourcegroups/rg-lab-az104-03-mgmt-groups"], deny: [] });
  });
});
