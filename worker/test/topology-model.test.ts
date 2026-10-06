// topology-model.test.ts: the graph model, the kinds registry and node keys (lab topology spec §4.1-§4.3, ruling 6).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TOPOLOGY_SCHEMA, sortGraph, type TopologyGraph, type TopoAssetKind, TOPO_ASSET_KINDS, TOPO_GROUP_KINDS } from "../../shared/topology/model";
import { GROUP_KINDS, KINDS, kindOfArm, kindOfTf, LIST_VIEW_AT, STACK_AT } from "../../shared/topology/kinds";
import { disambiguate, MOCK_NAME, nodeKey, normaliseName, planLabel } from "../../shared/topology/keys";

describe("model", () => {
  it("is schema 1", () => {
    expect(TOPOLOGY_SCHEMA).toBe(1);
  });

  it("sortGraph orders nodes and edges by id", () => {
    const g: TopologyGraph = {
      schema: 1,
      labId: "az104-13-vnets",
      version: 1,
      source: "planned",
      at: null,
      nodes: [
        { id: "tf:b", key: "b", kind: "vm", label: "b", props: {} },
        { id: "tf:a", key: "a", kind: "vm", label: "a", props: {} },
      ],
      edges: [
        { id: "e2", from: "tf:a", to: "tf:b", kind: "traffic" },
        { id: "e1", from: "tf:b", to: "tf:a", kind: "dependency" },
      ],
    };
    const s = sortGraph(g);
    expect(s.nodes.map((n) => n.id)).toEqual(["tf:a", "tf:b"]);
    expect(s.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    // A copy: the input is left as it was.
    expect(g.nodes[0]!.id).toBe("tf:b");
  });
});

describe("kinds", () => {
  it("every TopoAssetKind has a KINDS entry with an icon, placement and words", () => {
    for (const k of TOPO_ASSET_KINDS) {
      const d = KINDS[k];
      expect(d, k).toBeDefined();
      expect(d.icon, k).toMatch(/^[a-z0-9-]+$/);
      expect(["subnet", "vnet", "rg", "global", "tenant", "root"], k).toContain(d.placement);
      expect(d.word.length, k).toBeGreaterThan(0);
      expect(d.plural.length, k).toBeGreaterThan(0);
      expect(typeof d.liveVisible, k).toBe("boolean");
      expect(Number.isInteger(d.order), k).toBe(true);
    }
    for (const k of TOPO_GROUP_KINDS) expect(KINDS[k], k).toBeDefined();
    expect([...GROUP_KINDS].sort()).toEqual([...TOPO_GROUP_KINDS].sort());
  });

  it("kinds the live query cannot list are not liveVisible", () => {
    for (const k of ["managementGroup", "policy", "role", "entraPrincipal"] as TopoAssetKind[]) expect(KINDS[k].liveVisible, k).toBe(false);
    expect(KINDS.vm.liveVisible).toBe(true);
  });

  it("an ARM type maps to one kind, case-insensitive, and a virtual hub of kind RouteServer is a routeServer", () => {
    expect(kindOfArm("Microsoft.Compute/virtualMachines")).toBe("vm");
    expect(kindOfArm("microsoft.compute/VIRTUALMACHINES")).toBe("vm");
    expect(kindOfArm("Microsoft.Network/virtualHubs")).toBe("virtualHub");
    expect(kindOfArm("Microsoft.Network/virtualHubs", "RouteServer")).toBe("routeServer");
    expect(kindOfArm("microsoft.network/virtualhubs", "routeserver")).toBe("routeServer");
    expect(kindOfArm("Microsoft.Contoso/widgets")).toBe("generic");
    // No ARM type is claimed by two kinds.
    const seen = new Map<string, string>();
    for (const [k, d] of Object.entries(KINDS)) {
      for (const t of d.armTypes) {
        const lower = t.toLowerCase();
        expect(seen.get(lower), `${t} in ${k} and ${seen.get(lower)}`).toBeUndefined();
        seen.set(lower, k);
      }
    }
  });

  it("a Terraform type maps to its kind; unknown types are generic", () => {
    expect(kindOfTf("azurerm_linux_virtual_machine")).toBe("vm");
    expect(kindOfTf("azurerm_windows_virtual_machine")).toBe("vm");
    expect(kindOfTf("azurerm_virtual_network")).toBe("vnet");
    expect(kindOfTf("azurerm_monitor_action_group")).toBe("monitor");
    expect(kindOfTf("azurerm_resource_group_policy_assignment")).toBe("policy");
    expect(kindOfTf("azurerm_contoso_widget")).toBe("generic");
  });

  it("big-lab thresholds", () => {
    expect(STACK_AT).toBe(8);
    expect(LIST_VIEW_AT).toBe(300);
  });
});

describe("keys", () => {
  const ctx = { prefix: "l06k3x9q", region: "uksouth", secondaryRegion: "ukwest" };

  it("nodeKey lower-cases, replaces the prefix, region and secondary region, and nests a subnet under its VNet", () => {
    expect(nodeKey("Microsoft.Storage/storageAccounts", ["L06K3X9QSt"], ctx)).toBe("microsoft.storage/storageaccounts/{p}st");
    expect(nodeKey("Microsoft.Network/networkWatchers", ["NetworkWatcher_uksouth"], ctx)).toBe("microsoft.network/networkwatchers/networkwatcher_{r}");
    expect(nodeKey("Microsoft.Network/virtualNetworks", ["vnet-ukwest"], ctx)).toBe("microsoft.network/virtualnetworks/vnet-{r2}");
    expect(nodeKey("Microsoft.Network/virtualNetworks/subnets", ["vnet-hub", "snet-app"], ctx)).toBe("microsoft.network/virtualnetworks/subnets/vnet-hub/snet-app");
  });

  it("normaliseName replaces the longer region first (westus2 is not westus + 2)", () => {
    expect(normaliseName("vnet-westus2", { prefix: "l01abcde", region: "westus", secondaryRegion: "westus2" })).toBe("vnet-{r2}");
    expect(normaliseName("vnet-westus", { prefix: "l01abcde", region: "westus", secondaryRegion: "westus2" })).toBe("vnet-{r}");
    expect(normaliseName("x", { prefix: "l01abcde", region: "uksouth", secondaryRegion: null })).toBe("x");
  });

  it("the mock plan's names", () => {
    expect(MOCK_NAME.prefix("06")).toBe("l06k3x9q");
    expect(MOCK_NAME.region).toBe("uksouth");
    expect(MOCK_NAME.secondaryRegion).toBe("ukwest");
  });

  it("planLabel shows the mock prefix as l<NN>…", () => {
    expect(planLabel("l06k3x9qst", "06")).toBe("l06…st");
    expect(planLabel("vm-app", "06")).toBe("vm-app");
  });

  it("two nodes with one key get #secondary deterministically", () => {
    const nodes = [
      { id: "tf:b", key: "microsoft.network/virtualnetworks/vnet-app", group: "rg-lab-az700-40-lb-advanced-secondary" },
      { id: "tf:a", key: "microsoft.network/virtualnetworks/vnet-app", group: "rg-lab-az700-40-lb-advanced" },
      { id: "tf:c", key: "microsoft.network/virtualnetworks/vnet-hub", group: "rg-lab-az700-40-lb-advanced" },
    ];
    const once = disambiguate(nodes, "rg-lab-az700-40-lb-advanced");
    const twice = disambiguate([...nodes].reverse(), "rg-lab-az700-40-lb-advanced");
    expect(once).toEqual({
      "tf:a": "microsoft.network/virtualnetworks/vnet-app",
      "tf:b": "microsoft.network/virtualnetworks/vnet-app#secondary",
      "tf:c": "microsoft.network/virtualnetworks/vnet-hub",
    });
    expect(twice).toEqual(once);
  });

  it("a node in the secondary group keeps #secondary whether or not its twin is present (planned and live keys match)", () => {
    const P = "rg-lab-az700-40-lb-advanced";
    const both = disambiguate(
      [
        { id: "tf:a", key: "microsoft.network/virtualnetworks/vnet-app", group: P },
        { id: "tf:b", key: "microsoft.network/virtualnetworks/vnet-app", group: `${P}-secondary` },
      ],
      P,
    );
    // Live, before the primary twin exists (or after it is deleted): the secondary key must not shift.
    const alone = disambiguate([{ id: "/x/b", key: "microsoft.network/virtualnetworks/vnet-app", group: `${P}-secondary` }], P);
    expect(alone["/x/b"]).toBe(both["tf:b"]);
    expect(alone["/x/b"]).toBe("microsoft.network/virtualnetworks/vnet-app#secondary");
    // A unique name in the secondary group carries it too; the group itself (group: null) does not.
    expect(disambiguate([{ id: "u", key: "microsoft.network/loadbalancers/lb-ukw", group: `${P}-secondary` }, { id: "g", key: `microsoft.resources/resourcegroups/${P}-secondary`, group: null }], P)).toEqual({
      u: "microsoft.network/loadbalancers/lb-ukw#secondary",
      g: `microsoft.resources/resourcegroups/${P}-secondary`,
    });
  });

  it("the live and planned builders give a secondary group's resources the same keys", async () => {
    const { roundTrip } = await import("./fixtures/topology/round-trip");
    const r = roundTrip("az700-40-lb-advanced");
    expect({ added: r.added, missing: r.missing }).toEqual({ added: [], missing: [] });
    const planned = JSON.parse(readFileSync(new URL("../../shared/topology/planned/az700-40-lb-advanced.json", import.meta.url), "utf8")) as { nodes: { key: string; label: string }[] };
    expect(planned.nodes.find((n) => n.label === "lb-ukw")?.key).toMatch(/#secondary$/);
    expect(planned.nodes.find((n) => n.label === "vnet-ukw")?.key).toMatch(/#secondary$/);
    expect(planned.nodes.filter((n) => /resourcegroups\//.test(n.key)).map((n) => n.key).every((k) => !k.includes("#"))).toBe(true);
  });

  it("a collision inside one group falls back to a number, by id", () => {
    const nodes = [
      { id: "tf:y", key: "k", group: "rg-lab-az104-13-vnets" },
      { id: "tf:x", key: "k", group: "rg-lab-az104-13-vnets" },
    ];
    expect(disambiguate(nodes, "rg-lab-az104-13-vnets")).toEqual({ "tf:x": "k", "tf:y": "k#2" });
  });
});
