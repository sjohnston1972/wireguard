// topology-live-handmade.test.ts: T3.7 hand-made and Azure-made (lab topology plan T3.7, Review Focus 5). Per lab family,
// a resource added by hand of a known type and one of an unknown type, on top of the family lab's own rows
// (rows-from-planned.ts): both are "Added by hand", the unknown one a generic card, in the subnet its properties name or
// else in its group. One row per AZURE_MADE pattern: "Made by Azure", never "Added by hand". And every lab's planned
// graph turned into rows and back has no added or missing node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { AZURE_MADE, azureMadeGroups } from "../../shared/topology/rules/live";
import { diffGraphs } from "../../shared/topology/diff";
import { denyProblems } from "../../shared/topology/props";
import { LAB_IDS, liveCtxFor, plannedOf, roundTrip } from "./fixtures/topology/round-trip";
import { rowsFromPlanned } from "./fixtures/topology/rows-from-planned";

interface Family {
  lab: string;
  known: ArgRow;
  knownKind: string;
  unknown: ArgRow;
  unknownParent: string;
}
const fx = JSON.parse(readFileSync(new URL("./fixtures/topology/live/handmade.json", import.meta.url), "utf8")) as { families: Record<string, Family>; azureMade: { pattern: string; row: ArgRow }[]; azureGroups: ArgRow[] };
/** The groups Azure made, as the fixture's rows name them (azureMadeGroups over the same graph's rows). */
const made = azureMadeGroups([...fx.azureMade.map((a) => a.row), ...fx.azureGroups]);

describe("hand-made resources, per lab family (T3.7)", () => {
  for (const [family, f] of Object.entries(fx.families)) {
    describe(`${family} (${f.lab})`, () => {
      const planned = plannedOf(f.lab);
      const live = liveGraph([...rowsFromPlanned(planned), f.known, f.unknown], liveCtxFor(f.lab));
      const { status } = diffGraphs(planned, live);
      const node = (r: ArgRow) => live.nodes.find((n) => n.id === r.id.toLowerCase())!;
      const parentLabel = (r: ArgRow) => live.nodes.find((n) => n.id === node(r).parent)?.label;

      it("the known type is its kind and badged Added by hand", () => {
        expect(node(f.known).kind).toBe(f.knownKind);
        expect(status[node(f.known).key]).toBe("added");
      });

      it(`an unknown type is a generic card ${f.unknownParent.startsWith("rg-") ? "in its group (it names no subnet)" : "in the subnet its properties name"}, badged Added by hand`, () => {
        expect(node(f.unknown)).toMatchObject({ kind: "generic", armType: f.unknown.type });
        expect(parentLabel(f.unknown)).toBe(f.unknownParent);
        expect(status[node(f.unknown).key]).toBe("added");
      });

      it("nothing else is added and nothing planned goes missing; the deny check passes", () => {
        const added = Object.entries(status).filter(([, s]) => s === "added").map(([k]) => k).sort();
        expect(added).toEqual([node(f.known).key, node(f.unknown).key].sort());
        expect(Object.values(status).filter((s) => s === "missing")).toEqual([]);
        expect(denyProblems(live)).toEqual([]);
      });
    });
  }
});

describe("made by Azure (ruling 13): one row per AZURE_MADE pattern", () => {
  it("every pattern has a row here, and that row matches it", () => {
    expect(fx.azureMade.map((a) => a.pattern).sort()).toEqual(AZURE_MADE.map((m) => m.why).sort());
    for (const a of fx.azureMade) expect(AZURE_MADE.find((m) => m.why === a.pattern)!.test(a.row, made), a.pattern).toBe(true);
  });

  it("no pattern matches an ordinary hand-made row", () => {
    for (const f of Object.values(fx.families)) for (const r of [f.known, f.unknown]) expect(AZURE_MADE.filter((m) => m.test(r, made)).map((m) => m.why), r.name).toEqual([]);
  });

  it("an Azure-made resource Terraform does not declare is 'Made by Azure', never 'Added by hand'", () => {
    const lab = "az700-43-private-link";
    const planned = plannedOf(lab);
    const extra = [...fx.azureMade.map((a) => a.row).filter((r) => r.type !== "microsoft.network/virtualnetworks/virtualnetworkpeerings"), ...fx.azureGroups];
    const live = liveGraph([...rowsFromPlanned(planned), ...extra], liveCtxFor(lab));
    const { status } = diffGraphs(planned, live);
    expect(Object.entries(status).filter(([, s]) => s === "added")).toEqual([]);
    const azure = Object.entries(status).filter(([, s]) => s === "azure").map(([k]) => k);
    expect(azure).toEqual(expect.arrayContaining(["microsoft.compute/disks/vm-gone_osdisk_1_0a1b2c3d4e5f60718293a4b5c6d7e8f9", "microsoft.insights/datacollectionrules/nwta-0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9", "microsoft.network/networkwatchers/networkwatcher_{r}", "microsoft.resources/resourcegroups/rg-lab-az700-43-private-link-infra"]));
  });

  it("a private endpoint's NIC, an OS disk, NWTA* rules and ANM_ peerings are made by Azure, never added by hand", () => {
    for (const p of ["a private endpoint's network interface", "a VM's OS disk, named by Azure", "traffic analytics' data collection rule or endpoint", "a VNet peering Azure Virtual Network Manager made (ANM_…)"])
      expect(AZURE_MADE.find((m) => m.why === p)?.test(fx.azureMade.find((a) => a.pattern === p)!.row, made), p).toBe(true);
  });
});

// A group's name alone never makes it Azure's: only a cluster's nodeResourceGroup, an environment's
// infrastructureResourceGroup (rows in the same graph) or the group's own managedBy does. A learner's hand-made
// rg-lab-<id>-managed (or -infra, or -nodes) with resources in it is "Added by hand", like anything else they build.
describe("made by Azure only when a row names the group (not by its name)", () => {
  const SUB = "/subscriptions/00000000-0000-4000-8000-000000000000";
  const handGroup = (lab: string, suffix: string): ArgRow[] => {
    const rg = `rg-lab-${lab}-${suffix}`;
    return [
      { id: `${SUB}/resourceGroups/${rg}`, name: rg, type: "microsoft.resources/subscriptions/resourcegroups", resourceGroup: rg, managedBy: null },
      { id: `${SUB}/resourceGroups/${rg}/providers/Microsoft.Network/networkSecurityGroups/nsg-mine`, name: "nsg-mine", type: "microsoft.network/networksecuritygroups", kind: "", location: "uksouth", resourceGroup: rg, sku: null, tags: {}, zones: null, identity: null, managedBy: null, properties: { provisioningState: "Succeeded", securityRules: [] } },
    ];
  };
  for (const [lab, suffix] of [["az305-28-three-tier", "managed"], ["az305-29-aks", "infra"], ["az104-13-vnets", "nodes"]] as const) {
    it(`a hand-made rg-lab-<id>-${suffix} in ${lab}, and what is in it, are added by hand`, () => {
      const planned = plannedOf(lab);
      const rows = handGroup(lab, suffix);
      const live = liveGraph([...rowsFromPlanned(planned), ...rows], liveCtxFor(lab));
      const group = live.nodes.find((n) => n.label === rows[0]!.name)!;
      const nsg = live.nodes.find((n) => n.id === rows[1]!.id.toLowerCase())!;
      expect(group.madeBy).toBeUndefined();
      expect(nsg.madeBy).toBeUndefined();
      const { status } = diffGraphs(planned, live);
      expect(Object.entries(status).filter(([, s]) => s === "added").map(([k]) => k).sort()).toEqual([group.key, nsg.key].sort());
      expect(Object.values(status).filter((s) => s === "azure")).toEqual([]);
    });
  }

  it("azureMadeGroups: a cluster's nodeResourceGroup, an environment's infrastructureResourceGroup, a group row's managedBy; nothing by name", () => {
    const rg = "rg-lab-az305-28-three-tier";
    const rows: ArgRow[] = [
      { id: `${SUB}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/aks`, name: "aks", type: "microsoft.containerservice/managedclusters", resourceGroup: rg, properties: { nodeResourceGroup: "RG-LAB-X-NODES" } },
      { id: `${SUB}/resourceGroups/${rg}/providers/Microsoft.App/managedEnvironments/cae`, name: "cae", type: "microsoft.app/managedenvironments", resourceGroup: rg, properties: { infrastructureResourceGroup: "rg-lab-x-infra" } },
      { id: `${SUB}/resourceGroups/rg-lab-x-byazure`, name: "rg-lab-x-byazure", type: "microsoft.resources/subscriptions/resourcegroups", resourceGroup: "rg-lab-x-byazure", managedBy: `${SUB}/resourceGroups/${rg}/providers/Microsoft.Databricks/workspaces/w` },
      { id: `${SUB}/resourceGroups/rg-lab-x-managed`, name: "rg-lab-x-managed", type: "microsoft.resources/subscriptions/resourcegroups", resourceGroup: "rg-lab-x-managed", managedBy: null },
    ];
    expect([...azureMadeGroups(rows)].sort()).toEqual(["rg-lab-x-byazure", "rg-lab-x-infra", "rg-lab-x-nodes"]);
  });
});

describe("every lab's planned graph turned into rows and back has no added or missing node", () => {
  // An empty group (lab 3) is drawn from its own row: the query unions resourcecontainers.
  for (const id of LAB_IDS) {
    it(`${id}`, () => {
      const r = roundTrip(id);
      expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    });
  }
});
