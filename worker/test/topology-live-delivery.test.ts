// topology-live-delivery.test.ts: T3.2 delivery (lab topology plan T3.2). Live derivation of load balancers (rules, NAT,
// outbound, global tier, gateway chain), application gateways and WAF policies, Front Door, Private Link services and
// Traffic Manager from Resource Graph row fixtures (fixtures/topology/live/delivery.json), and the round trip of the
// family's labs (16, 27, 40, 41, 42).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, roundTrip } from "./fixtures/topology/round-trip";

const rows = (JSON.parse(readFileSync(new URL("./fixtures/topology/live/delivery.json", import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
const g = liveGraph(rows, liveCtxFor("az700-42-frontdoor-private"));

const byLabel = (graph: TopologyGraph, label: string): TopoNode => {
  const n = graph.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${graph.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (graph: TopologyGraph, n: TopoNode) => graph.nodes.find((x) => x.id === n.parent)?.label;
const edgesBetween = (graph: TopologyGraph, from: string, to: string) => graph.edges.filter((e) => e.from === byLabel(graph, from).id && e.to === byLabel(graph, to).id);

describe("live delivery (T3.2)", () => {
  it("an application gateway sits in its subnet with SKU, capacity and private frontend, and its state word", () => {
    const a = byLabel(g, "agw-hub");
    expect(parentLabel(g, a)).toBe("snet-agw");
    expect(a.props).toMatchObject({ sku: "WAF_v2", capacity: "0-2", privateIp: "10.66.194.10" });
    expect(a.health).toEqual({ tone: "ok", word: "Running" });
    expect(a.folded?.map((f) => f.label)).toEqual(["pip-agw"]);
  });

  it("App Gateway → each backend (by NIC, and by address), labelled listener port → backend port", () => {
    expect(edgesBetween(g, "agw-hub", "vm-web").map((e) => e.label)).toEqual(["HTTPS 443→80"]);
    expect(edgesBetween(g, "agw-hub", "vm-web2").map((e) => e.label)).toEqual(["HTTPS 443→80"]);
  });

  it("a WAF policy is a card in its group with its mode and a dependency edge to the gateway it protects", () => {
    const w = byLabel(g, "waf-hub");
    expect(w).toMatchObject({ kind: "wafPolicy", props: { mode: "Prevention" } });
    expect(parentLabel(g, w)).toBe("rg-lab-az700-42-frontdoor-private");
    expect(edgesBetween(g, "waf-hub", "agw-hub")).toMatchObject([{ kind: "dependency", label: "WAF policy" }]);
  });

  it("a global-tier LB sits in the Global lane and reaches each regional LB; a regional frontend chains to the gateway LB", () => {
    const lbg = byLabel(g, "lb-global");
    expect(parentLabel(g, lbg)).toBe("Global");
    expect(edgesBetween(g, "lb-global", "lb-uks").map((e) => e.label)).toEqual(["TCP 80→80"]);
    expect(edgesBetween(g, "lb-global", "lb-ukw").map((e) => e.label)).toEqual(["TCP 80→80"]);
    expect(edgesBetween(g, "lb-uks", "lb-gw").map((e) => e.label)).toEqual(["chain"]);
    expect(edgesBetween(g, "lb-gw", "vm-nva").map((e) => e.label)).toEqual(["HA ports"]);
    expect(parentLabel(g, byLabel(g, "lb-ukw"))).toBe("rg-lab-az700-42-frontdoor-private-secondary");
  });

  it("a Private Link service sits in its NAT subnet with a frontend edge to its LB; its NIC is made by Azure and folded", () => {
    const pls = byLabel(g, "pls-web");
    expect(parentLabel(g, pls)).toBe("snet-pls");
    expect(edgesBetween(g, "pls-web", "lb-int").map((e) => e.label)).toEqual(["frontend"]);
    expect(pls.folded?.map((f) => f.label)).toEqual(["pls-web.nic.6f0d2c3b-1a4e-4b5c-9d8e-7f6a5b4c3d2e"]);
    expect(edgesBetween(g, "lb-int", "vm-web").map((e) => e.label)).toEqual(["TCP 80→80"]);
  });

  it("a Private Link service's NIC folds into it by the service's own NIC list when the NIC row names no service", () => {
    const bare = rows.map((r) => (/\/networkinterfaces\/pls-web\.nic\./i.test(r.id) ? { ...r, properties: { ...r.properties, privateLinkService: undefined } } : r));
    const h = liveGraph(bare, liveCtxFor("az700-42-frontdoor-private"));
    expect(h.nodes.some((n) => /^pls-web\.nic\./.test(n.label))).toBe(false);
    expect(byLabel(h, "pls-web").folded?.map((f) => f.label)).toEqual(["pls-web.nic.6f0d2c3b-1a4e-4b5c-9d8e-7f6a5b4c3d2e"]);
  });

  it("Front Door is a card in the Global lane with its SKU and endpoint host (endpoint folded); an origin row's Private Link edge carries its approval state", () => {
    const fd = byLabel(g, "afd-premium");
    expect(fd).toMatchObject({ kind: "frontDoor", props: { sku: "Premium_AzureFrontDoor", hostName: "l42rt7xy-afd-abcdefgh.z01.azurefd.net" } });
    expect(parentLabel(g, fd)).toBe("Global");
    expect(fd.folded?.map((f) => f.label).sort()).toEqual(["l42rt7xy-afd", "origin-lb-int"]);
    expect(edgesBetween(g, "afd-premium", "pls-web")).toMatchObject([{ kind: "traffic", label: "Private Link", state: { tone: "warn", word: "Pending approval" } }]);
  });

  it("Front Door's WAF policy sits in the Global lane with a dependency edge to its profile", () => {
    const w = byLabel(g, "wafpremium");
    expect(parentLabel(g, w)).toBe("Global");
    expect(w.props.mode).toBe("Prevention");
    expect(edgesBetween(g, "wafpremium", "afd-premium")).toMatchObject([{ kind: "dependency", label: "WAF policy" }]);
  });

  it("Traffic Manager is in the Global lane; each endpoint is an edge to its target (by FQDN or resource id) with its priority and monitor state", () => {
    const tm = byLabel(g, "l42rt7xy-tm");
    expect(tm).toMatchObject({ kind: "trafficManager", props: { routing: "Priority" } });
    expect(parentLabel(g, tm)).toBe("Global");
    expect(edgesBetween(g, "l42rt7xy-tm", "ci-uks")).toMatchObject([{ kind: "traffic", label: "priority 1", state: { tone: "ok", word: "Online" } }]);
    expect(edgesBetween(g, "l42rt7xy-tm", "pip-tm")).toMatchObject([{ label: "priority 2", state: { tone: "warn", word: "Degraded" } }]);
  });

  it("the deny check passes and nothing here is drawn plainly", () => {
    expect(denyProblems(g)).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "generic").map((n) => n.label)).toEqual([]);
  });
});

describe("round trip: the delivery labs", () => {
  for (const id of ["az104-16-lb-appgw", "az305-27-multi-region", "az305-28-three-tier", "az700-40-lb-advanced", "az700-41-appgw-waf", "az700-42-frontdoor-private"]) {
    it(`${id}: planned → rows → live has no added and no missing node, and passes the deny check`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }

  it("lab 40's live graph keeps the global → regional and chain edges", () => {
    const r = roundTrip("az700-40-lb-advanced");
    expect(edgesBetween(r.live, "lb-global", "lb-uks").length).toBe(1);
    expect(edgesBetween(r.live, "lb-uks", "lb-gw").map((e) => e.label)).toEqual(["chain"]);
  });
});
