// topology-live-network.test.ts: T3.1 network core (lab topology plan T3.1). Live derivation per type from Resource Graph
// row fixtures (fixtures/topology/live/network.json, shapes from Learn's REST references), and the round trip of the
// family's labs (6, 7, 8, 13, 14, 15, 17, 31, 32, 35): planned → rows → live, nothing added, nothing missing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { ARM_RULES, AZURE_MADE, peeringEdges, type LiveHelpers } from "../../shared/topology/rules/live";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/network.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az700-32-dns-resolver", { namePrefix: "l32rt7xy" }));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edge = (graph: TopologyGraph, from: string, to: string, label?: string) =>
  graph.edges.find((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id && (label === undefined || e.label === label));

describe("live network core (T3.1)", () => {
  it("subnets carry their chips: NSG, route table, NAT gateway, delegation, service endpoints, no default outbound", () => {
    expect(byLabel(g, "snet-app").props.chips).toEqual(["NSG nsg-app", "route table rt-app", "NAT gateway ng-hub", "service endpoints Microsoft.Storage", "no default outbound"]);
    expect(byLabel(g, "snet-in").props.chips).toEqual(["delegation Microsoft.Network/dnsResolvers"]);
    expect(byLabel(g, "snet-app").folded?.map((f) => f.label).sort()).toEqual(["nsg-app", "rt-app"]);
  });

  it("peering is one edge per pair with its state; the VNet shows its DNS servers", () => {
    const peer = g.edges.filter((e) => e.label === "peering");
    expect(peer).toHaveLength(1);
    expect(peer[0]!.state).toEqual({ tone: "ok", word: "Connected" });
    expect(byLabel(g, "vnet-onprem").props.dnsServers).toEqual(["10.66.208.4"]);
  });

  it("the route's next hop goes from the subnet to the appliance holding the IP; an Internet hop draws nothing", () => {
    expect(edge(g, "snet-app", "vm-dns", "10.66.208.0/20")).toMatchObject({ kind: "traffic" });
    expect(g.edges.filter((e) => e.label === "203.0.113.0/24")).toEqual([]);
  });

  it("a NAT gateway is a card with its prefix folded in and the subnet's outbound edge; an LB's prefix folds into the LB", () => {
    const ng = byLabel(g, "ng-hub");
    expect(ng).toMatchObject({ kind: "natGateway", props: { sku: "Standard" } });
    expect(ng.folded?.map((f) => f.label)).toEqual(["pfx-nat"]);
    expect(edge(g, "snet-app", "ng-hub", "outbound")).toBeDefined();
    expect(byLabel(g, "lb-out").folded?.map((f) => f.label)).toEqual(["pfx-lb"]);
    expect(g.nodes.some((n) => n.kind === "publicIpPrefix")).toBe(false);
    expect(edge(g, "vm-lb", "lb-out", "outbound")).toBeDefined();
  });

  it("an ASG folds into its member's VM, which shows it as a chip (as the planned graph pulls it in)", () => {
    expect(g.nodes.some((n) => n.label === "asg-app")).toBe(false);
    const vm = byLabel(g, "vm-app");
    expect(vm.folded?.map((f) => f.label)).toContain("asg-app");
    expect(vm.props.chips).toEqual(["ASG asg-app"]);
  });

  it("the DNS private resolver sits in its VNet with its endpoints folded; the ruleset depends on its outbound endpoint", () => {
    const r = byLabel(g, "dnspr-hub");
    expect(r.kind).toBe("dnsResolver");
    expect(parentLabel(g, r)).toBe("vnet-hub");
    expect(r.folded?.map((f) => f.label).sort()).toEqual(["in-hub", "out-hub"]);
    expect(g.nodes.some((n) => n.label === "in-hub" || n.label === "out-hub")).toBe(false);
    const rs = byLabel(g, "frs-onprem");
    expect(parentLabel(g, rs)).toBe("rg-lab-az700-32-dns-resolver");
    expect(edge(g, "frs-onprem", "dnspr-hub", "outbound endpoint")).toMatchObject({ kind: "dependency" });
  });

  it("the resolver's inbound IP comes from its inbound endpoint row (when the builder offers rowsOfType)", () => {
    const resolver = rows.find((r) => r.name === "dnspr-hub")!;
    const h: LiveHelpers = { row: () => undefined, home: () => null, nodeByPrivateIp: () => null, nicsOf: () => [], rowsOfType: (t) => rows.filter((r) => r.type === t) };
    expect(ARM_RULES["microsoft.network/dnsresolvers"]!.props!(resolver, h)).toMatchObject({ privateIp: "10.66.193.4" });
  });

  it("zones count their own records (not SOA and NS); a private zone's link is folded and drawn as a link edge", () => {
    const pz = byLabel(g, "azure.lab32.internal");
    expect(pz.props.counts).toEqual(["records: 2"]);
    expect(pz.folded?.map((f) => f.label)).toEqual(["link-hub"]);
    expect(edge(g, "azure.lab32.internal", "vnet-hub", "link (auto-registration)")).toMatchObject({ kind: "dependency" });
    const z = byLabel(g, "l32rt7xy.example.com");
    expect(z).toMatchObject({ kind: "dnsZone", props: { counts: ["records: 2"] } });
    expect(parentLabel(g, z)).toBe("Global");
    expect(z.key).toBe("microsoft.network/dnszones/{p}.example.com");
  });

  it("AVNM's ANM_ peerings are made by Azure and say so on their edge", () => {
    const vnet = { id: "/subscriptions/s/resourceGroups/rg-lab-x/providers/Microsoft.Network/virtualNetworks/vnet-a", name: "vnet-a", type: "microsoft.network/virtualnetworks", resourceGroup: "rg-lab-x", properties: { virtualNetworkPeerings: [{ id: "/subscriptions/s/resourceGroups/rg-lab-x/providers/Microsoft.Network/virtualNetworks/vnet-a/virtualNetworkPeerings/ANM_A1B2C3_vnet-hub", name: "ANM_A1B2C3_vnet-hub", properties: { peeringState: "Connected", remoteVirtualNetwork: { id: "/subscriptions/s/resourceGroups/rg-lab-x/providers/Microsoft.Network/virtualNetworks/vnet-hub" } } }] } } as ArgRow;
    expect(peeringEdges(vnet, () => false)[0]?.label).toBe("peering (AVNM)");
    expect(AZURE_MADE.some((m) => m.test({ ...vnet, id: `${vnet.id}/virtualNetworkPeerings/ANM_A1B2C3_vnet-hub`, name: "ANM_A1B2C3_vnet-hub", type: "microsoft.network/virtualnetworks/virtualnetworkpeerings" }))).toBe(true);
  });

  it("the deny check passes and no type here is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the network core labs", () => {
  for (const id of ["az104-06-blob-security", "az104-07-files", "az104-08-vms", "az104-13-vnets", "az104-14-peering-udr", "az104-15-dns", "az104-17-netwatcher-fix", "az700-31-ip-nat-outbound", "az700-32-dns-resolver", "az700-35-forced-tunnel-fix"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }

  it("lab 32's live graph keeps the planned shape: resolver in vnet-hub, the forward rule's ruleset in the group, the peering", () => {
    const r = roundTrip("az700-32-dns-resolver");
    expect(parentLabel(r.live, byLabel(r.live, "dnspr-hub"))).toBe("vnet-hub");
    expect(r.live.edges.filter((e) => e.label === "peering")).toHaveLength(1);
  });
});
