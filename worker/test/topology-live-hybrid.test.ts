// topology-live-hybrid.test.ts: T3.3 hybrid and hubs (lab topology plan T3.3). Live derivation of VPN gateways, local
// network gateways and connections, Route Server and its BGP peers, firewalls and policies, Virtual WAN and a secured
// hub, and AVNM from Resource Graph row fixtures (fixtures/topology/live/hybrid.json), and the round trip of the
// family's labs (33, 34, 36, 37, 38, 39).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/hybrid.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az700-36-s2s-vpn"));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("live hybrid and hubs (T3.3)", () => {
  it("a VPN gateway sits in GatewaySubnet with SKU, BGP and ASN; its public IP folds in", () => {
    const gw = byLabel(g, "vpngw-azure");
    expect(parentLabel(g, gw)).toBe("GatewaySubnet");
    expect(gw.props).toMatchObject({ sku: "VpnGw1AZ", asn: 65010, bgp: true, vpnType: "RouteBased" });
    expect(gw.folded?.map((f) => f.label).sort()).toEqual(["cn-azure-to-onprem", "pip-vpngw-azure"]);
  });

  it("a point-to-site gateway shows its client address pool", () => {
    expect(byLabel(g, "vpngw-p2s").props).toMatchObject({ clientPool: "10.66.255.0/24", bgp: false });
  });

  it("a local network gateway shows its address space and ASN, and points at the gateway it stands for", () => {
    const l = byLabel(g, "lgw-onprem");
    expect(l).toMatchObject({ kind: "localNetworkGateway", props: { addressSpace: ["10.66.208.0/20"], asn: 65020 } });
    expect(edgesBetween(g, "lgw-onprem", "vpngw-onprem")).toMatchObject([{ kind: "dependency", label: "gateway address" }]);
  });

  it("a connection folds into its gateway and is an edge to the far side, with its connectionStatus", () => {
    expect(g.nodes.some((n) => n.label.startsWith("cn-"))).toBe(false);
    expect(byLabel(g, "vpngw-azure").folded?.map((f) => f.label)).toEqual(expect.arrayContaining(["cn-azure-to-onprem"]));
    expect(edgesBetween(g, "vpngw-azure", "lgw-onprem")).toMatchObject([{ kind: "traffic", label: "IPsec, BGP", state: { tone: "ok", word: "Connected" } }]);
    expect(edgesBetween(g, "vpngw-onprem", "lgw-azure")[0]?.state).toEqual({ tone: "warn", word: "Connecting" });
  });

  it("a Route Server sits in the subnet holding its router IPs, with ASN and IPs; a BGP connection row is a BGP edge to the NVA", () => {
    const rs = byLabel(g, "rs-hub");
    expect(rs.kind).toBe("routeServer");
    expect(parentLabel(g, rs)).toBe("RouteServerSubnet");
    expect(rs.props).toMatchObject({ asn: 65515, privateIp: "10.66.194.4" });
    expect(rs.folded?.map((f) => f.label).sort()).toEqual(["bgp-nva", "pip-rs"]);
    expect(edgesBetween(g, "rs-hub", "vm-nva")).toMatchObject([{ kind: "traffic", label: "BGP 65010", state: { tone: "ok", word: "Connected" } }]);
  });

  it("a firewall sits in AzureFirewallSubnet with tier and private IP; its policy and the base policy are dependency edges", () => {
    const f = byLabel(g, "afw-hub");
    expect(parentLabel(g, f)).toBe("AzureFirewallSubnet");
    expect(f.props).toMatchObject({ tier: "Basic", privateIp: "10.66.230.4" });
    expect(f.folded?.map((x) => x.label).sort()).toEqual(["pip-afw", "pip-afw-mgmt"]);
    expect(edgesBetween(g, "afw-hub", "fwp-hub")).toMatchObject([{ kind: "dependency", label: "policy" }]);
    expect(edgesBetween(g, "fwp-base", "fwp-hub")).toMatchObject([{ kind: "dependency", label: "base policy" }]);
    expect(byLabel(g, "fwp-hub").props).toMatchObject({ tier: "Basic", counts: ["rule collection groups: 1"] });
  });

  it("a virtual hub is a group with the secured hub's firewall inside; the WAN depends on it; HV_ peerings are hub connections", () => {
    const hub = byLabel(g, "vhub-lab");
    expect(hub).toMatchObject({ kind: "virtualHub", props: { prefix: "10.66.240.0/23", sku: "Standard" } });
    const fw = byLabel(g, "afw-vhub");
    expect(parentLabel(g, fw)).toBe("vhub-lab");
    expect(fw.props.privateIp).toBe("10.66.240.132");
    expect(edgesBetween(g, "vwan-lab", "vhub-lab")).toMatchObject([{ kind: "dependency", label: "virtual hub" }]);
    expect(edgesBetween(g, "vhub-lab", "vnet-spoke1")).toMatchObject([{ kind: "traffic", label: "hub connection", state: { tone: "ok", word: "Connected" } }]);
  });

  it("a network manager shows its scope accesses; its ANM_ peerings are drawn as AVNM peerings", () => {
    expect(byLabel(g, "avnm-l36rt7xy").props.scopeAccess).toEqual(["Connectivity", "SecurityAdmin"]);
    const e = g.edges.find((x) => x.label === "peering (AVNM)");
    expect([e?.from, e?.to].sort()).toEqual([byLabel(g, "vnet-azure").id, byLabel(g, "vnet-spoke2").id].sort());
  });

  it("the deny check passes and nothing here is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the hybrid labs", () => {
  for (const id of ["az700-33-vnet-manager", "az700-34-route-server", "az700-36-s2s-vpn", "az700-37-p2s-vpn", "az700-38-hub-firewall", "az700-39-vwan-secured-hub"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }

  it("lab 39's live firewall sits in its hub and lab 34's Route Server in RouteServerSubnet, as planned", () => {
    const l39 = roundTrip("az700-39-vwan-secured-hub");
    expect(parentLabel(l39.live, byLabel(l39.live, "afw-vhub"))).toBe("vhub-lab");
    const l34 = roundTrip("az700-34-route-server");
    expect(parentLabel(l34.live, byLabel(l34.live, "rs-hub"))).toBe("RouteServerSubnet");
  });
});
