// topology-diff.test.ts: planned and live together (lab topology spec §7, ruling 23).

import { describe, expect, it } from "vitest";
import { badgeOf, diffGraphs, mergeForView, MOCK_SLOT, rebaseSlot } from "../../shared/topology/diff";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";

const node = (id: string, key: string, kind: TopoNode["kind"], extra: Partial<TopoNode> = {}): TopoNode => ({ id, key, kind, label: key.split("/").at(-1)!, props: {}, ...extra });
const graph = (source: "planned" | "live", nodes: TopoNode[], edges: TopologyGraph["edges"] = []): TopologyGraph => ({ schema: 1, labId: "az104-13-vnets", version: 3, source, at: source === "live" ? "2026-10-06T12:00:00.000Z" : null, nodes, edges });

const RG = "microsoft.resources/resourcegroups/rg-lab-az104-13-vnets";
const VNET = "microsoft.network/virtualnetworks/vnet-lab";
const SNET = "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-web";

const planned = graph(
  "planned",
  [
    node("tf:rg", RG, "resourceGroup"),
    node("tf:vnet", VNET, "vnet", { parent: "tf:rg" }),
    node("tf:snet", SNET, "subnet", { parent: "tf:vnet", props: { prefix: "10.71.192.0/24" } }),
    node("tf:vm-web", "microsoft.compute/virtualmachines/vm-web", "vm", { parent: "tf:snet", scope: "lab", props: { privateIp: "10.71.192.4" } }),
    node("tf:vm-gone", "microsoft.compute/virtualmachines/vm-gone", "vm", { parent: "tf:snet", scope: "lab" }),
    node("tf:policy", "microsoft.authorization/policyassignments/deny-x", "policy", { parent: "tf:rg", scope: "lab" }),
    node("tf:flowlog", "microsoft.network/networkwatchers/flowlogs/networkwatcher_{r}/fl", "generic", { parent: "tf:rg", scope: "outside" }),
  ],
  [{ id: "e1", from: "tf:vm-web", to: "tf:vm-gone", kind: "traffic", label: "TCP 80→80" }],
);
const L = "/subscriptions/00000000-0000-4000-8000-000000000000/resourcegroups/rg-lab-az104-13-vnets";
const live = graph("live", [
  node(L, RG, "resourceGroup"),
  node(`${L}/providers/microsoft.network/virtualnetworks/vnet-lab`, VNET, "vnet", { parent: L }),
  node(`${L}/providers/microsoft.network/virtualnetworks/vnet-lab/subnets/snet-web`, SNET, "subnet", { parent: `${L}/providers/microsoft.network/virtualnetworks/vnet-lab` }),
  node(`${L}/providers/microsoft.compute/virtualmachines/vm-web`, "microsoft.compute/virtualmachines/vm-web", "vm", { parent: `${L}/providers/microsoft.network/virtualnetworks/vnet-lab/subnets/snet-web`, health: { tone: "ok", word: "Running" } }),
  node(`${L}/providers/microsoft.network/networksecuritygroups/nsg-handmade`, "microsoft.network/networksecuritygroups/nsg-handmade", "nsg", { parent: L }),
  node(`${L}/providers/microsoft.insights/datacollectionrules/nwta-x`, "microsoft.insights/datacollectionrules/nwta-x", "monitor", { parent: L, madeBy: "azure" }),
]);

describe("diffGraphs", () => {
  const { status } = diffGraphs(planned, live);

  it("both: the key is in both", () => {
    expect(status[VNET]).toBe("both");
    expect(status["microsoft.compute/virtualmachines/vm-web"]).toBe("both");
  });
  it("added: live only, not made by Azure", () => {
    expect(status["microsoft.network/networksecuritygroups/nsg-handmade"]).toBe("added");
  });
  it("azure: live only, made by Azure", () => {
    expect(status["microsoft.insights/datacollectionrules/nwta-x"]).toBe("azure");
  });
  it("missing: planned only, live-visible, in the lab", () => {
    expect(status["microsoft.compute/virtualmachines/vm-gone"]).toBe("missing");
  });
  it("kinds the query cannot list are unlisted, never missing; so is a resource outside the lab's groups", () => {
    expect(status["microsoft.authorization/policyassignments/deny-x"]).toBe("unlisted");
    expect(status["microsoft.network/networkwatchers/flowlogs/networkwatcher_{r}/fl"]).toBe("unlisted");
  });
});

describe("badges", () => {
  it("each status has its words; while deploying, missing reads Not deployed yet", () => {
    expect(badgeOf("both")).toBeNull();
    expect(badgeOf("added")).toBe("Added by hand");
    expect(badgeOf("azure")).toBe("Made by Azure");
    expect(badgeOf("missing")).toBe("Not deployed or removed");
    expect(badgeOf("missing", { deploying: true })).toBe("Not deployed yet");
    expect(badgeOf("unlisted")).toBe("Not listed by the live view");
  });
});

describe("mergeForView", () => {
  const { graph: g, status } = mergeForView(planned, live);

  it("is the live graph plus ghosts for what is planned but not live", () => {
    expect(g.source).toBe("live");
    expect(g.nodes.filter((n) => n.id.startsWith("/subscriptions/")).length).toBe(live.nodes.length);
    expect(g.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(["microsoft.compute/virtualmachines/vm-gone", "microsoft.authorization/policyassignments/deny-x"]));
    expect(status["microsoft.compute/virtualmachines/vm-gone"]).toBe("missing");
  });

  it("ghosts keep their planned parent by key", () => {
    const ghost = g.nodes.find((n) => n.key === "microsoft.compute/virtualmachines/vm-gone")!;
    expect(ghost.parent).toBe(`${L}/providers/microsoft.network/virtualnetworks/vnet-lab/subnets/snet-web`);
    const policy = g.nodes.find((n) => n.key === "microsoft.authorization/policyassignments/deny-x")!;
    expect(policy.parent).toBe(L);
  });

  it("a ghost's edges follow it, joined to the live nodes by key", () => {
    expect(g.edges).toEqual([expect.objectContaining({ from: `${L}/providers/microsoft.compute/virtualmachines/vm-web`, to: "tf:vm-gone", label: "TCP 80→80" })]);
  });

  it("a ghost whose planned parent is also missing keeps that parent as a ghost", () => {
    const p2 = graph("planned", [...planned.nodes, node("tf:snet2", "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-db", "subnet", { parent: "tf:vnet" }), node("tf:vm-db", "microsoft.compute/virtualmachines/vm-db", "vm", { parent: "tf:snet2", scope: "lab" })]);
    const m = mergeForView(p2, live);
    const vm = m.graph.nodes.find((n) => n.key === "microsoft.compute/virtualmachines/vm-db")!;
    expect(vm.parent).toBe("tf:snet2");
    expect(m.graph.nodes.find((n) => n.id === "tf:snet2")?.parent).toBe(`${L}/providers/microsoft.network/virtualnetworks/vnet-lab`);
  });
});

describe("rebaseSlot", () => {
  it("rebaseSlot moves addresses and CIDRs inside 10.71.192.0/18 only", () => {
    expect(MOCK_SLOT).toBe("10.71.192.0/18");
    const g = graph(
      "planned",
      [
        node("tf:snet", SNET, "subnet", { props: { prefix: "10.71.193.0/24", chips: ["NSG nsg-web"] } }),
        node("tf:vm", "k", "vm", { props: { privateIp: "10.71.255.254", addressSpace: ["10.71.192.0/20", "10.50.0.0/16"], hostName: "vm.10.71.192.4.example" } }),
      ],
      [{ id: "e", from: "tf:snet", to: "tf:vm", kind: "traffic", label: "0.0.0.0/0" }, { id: "f", from: "tf:snet", to: "tf:vm", kind: "traffic", label: "10.71.200.0/24" }],
    );
    const r = rebaseSlot(g, "10.64.192.0/18");
    expect(r.nodes[0]!.props.prefix).toBe("10.64.193.0/24");
    expect(r.nodes[1]!.props.privateIp).toBe("10.64.255.254");
    expect(r.nodes[1]!.props.addressSpace).toEqual(["10.64.192.0/20", "10.50.0.0/16"]);
    expect(r.edges.map((e) => e.label)).toEqual(["0.0.0.0/0", "10.64.200.0/24"]);
    // The input is not changed.
    expect(g.nodes[0]!.props.prefix).toBe("10.71.193.0/24");
    // Addresses just outside the slot stay.
    expect(rebaseSlot(graph("planned", [node("a", "a", "vm", { props: { privateIp: "10.71.191.255" } }), node("b", "b", "vm", { props: { privateIp: "10.72.0.0" } })]), "10.64.0.0/18").nodes.map((n) => n.props.privateIp)).toEqual(["10.71.191.255", "10.72.0.0"]);
  });
});
