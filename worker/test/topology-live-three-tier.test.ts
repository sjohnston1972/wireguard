// topology-live-three-tier.test.ts: lab 28 (az305-28-three-tier) on the live diagram. Its workload-profiles Container
// Apps environment makes a group of Azure's own, named by the lab rg-lab-<id>-infra, holding the environment's load
// balancer and its two public IPs. That group and everything in it are "Made by Azure", never "Added by hand"; the
// orphan sweep and the safety net count the group as lab 28's. Rows are shaped as Resource Graph returns them (fake
// subscription, TEST-NET addresses; Azure picks the names inside the group), added to the lab's planned graph turned
// into rows.

import { describe, expect, it } from "vitest";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { diffGraphs } from "../../shared/topology/diff";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { labIdFromName, ownsName } from "../../shared/labs";
import { liveCtxFor, plannedOf, LAB_IDS } from "./fixtures/topology/round-trip";
import { rowsFromPlanned, SUB } from "./fixtures/topology/rows-from-planned";

const LAB = "az305-28-three-tier";
const RG = `rg-lab-${LAB}`;
const INFRA = `${RG}-infra`;
const envId = `${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/cae-lab`;
const inInfra = (provider: string, name: string) => `${SUB}/resourceGroups/${INFRA}/providers/${provider}/${name}`;
const lbId = inInfra("Microsoft.Network/loadBalancers", "capp-svc-lb");
const pipIn = inInfra("Microsoft.Network/publicIPAddresses", "capp-svc-lb-ip-4f1d");
const pipOut = inInfra("Microsoft.Network/publicIPAddresses", "capp-outbound-ip-4f1d");

const row = (id: string, type: string, extra: Partial<ArgRow> = {}): ArgRow => ({
  id,
  name: id.split("/").at(-1)!,
  type,
  kind: "",
  location: "uksouth",
  resourceGroup: id.split("/")[4]!,
  sku: null,
  tags: {},
  zones: null,
  identity: null,
  managedBy: null,
  properties: { provisioningState: "Succeeded" },
  ...extra,
});

/** What the platform makes in the infrastructure group for a Consumption-only environment with external ingress. */
const infraRows = (groupManagedBy: string | null): ArgRow[] => [
  row(`${SUB}/resourceGroups/${INFRA}`, "microsoft.resources/subscriptions/resourcegroups", { managedBy: groupManagedBy }),
  row(lbId, "microsoft.network/loadbalancers", {
    sku: { name: "Standard", tier: "Regional" },
    properties: {
      provisioningState: "Succeeded",
      frontendIPConfigurations: [
        { id: `${lbId}/frontendIPConfigurations/in`, name: "in", properties: { publicIPAddress: { id: pipIn } } },
        { id: `${lbId}/frontendIPConfigurations/out`, name: "out", properties: { publicIPAddress: { id: pipOut } } },
      ],
      backendAddressPools: [{ id: `${lbId}/backendAddressPools/capp`, name: "capp", properties: {} }],
    },
  }),
  row(pipIn, "microsoft.network/publicipaddresses", { sku: { name: "Standard", tier: "Regional" }, properties: { provisioningState: "Succeeded", ipAddress: "203.0.113.28", publicIPAllocationMethod: "Static", ipConfiguration: { id: `${lbId}/frontendIPConfigurations/in` } } }),
  row(pipOut, "microsoft.network/publicipaddresses", { sku: { name: "Standard", tier: "Regional" }, properties: { provisioningState: "Succeeded", ipAddress: "203.0.113.29", publicIPAllocationMethod: "Static", ipConfiguration: { id: `${lbId}/frontendIPConfigurations/out` } } }),
];

const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};

describe("live three-tier (lab 28): the Container Apps infrastructure group", () => {
  const planned = plannedOf(LAB);

  it("the environment names its infrastructure group, planned and live (the chip that marks the group as Azure's)", () => {
    const chip = `infra group ${INFRA}`;
    expect(byLabel(planned, "cae-lab").props.chips).toEqual([chip]);
    const live = liveGraph([...rowsFromPlanned(planned), ...infraRows(null)], liveCtxFor(LAB));
    expect(byLabel(live, "cae-lab").props.chips).toEqual([chip]);
  });

  // Whether or not Azure sets managedBy on the group, the environment's infrastructureResourceGroup names it.
  for (const managedBy of [null, envId]) {
    it(`rg-lab-<id>-infra and its load balancer and public IPs are made by Azure, never added by hand (group managedBy ${managedBy ? "set" : "unset"})`, () => {
      const live = liveGraph([...rowsFromPlanned(planned), ...infraRows(managedBy)], liveCtxFor(LAB));
      const group = byLabel(live, INFRA);
      expect(group.madeBy).toBe("azure");
      const inGroup = live.nodes.filter((n) => n.parent === group.id);
      expect(inGroup.length).toBeGreaterThan(0);
      for (const n of inGroup) expect(n.madeBy, n.label).toBe("azure");
      const { status } = diffGraphs(planned, live);
      expect(Object.entries(status).filter(([, s]) => s === "added")).toEqual([]);
      expect(Object.entries(status).filter(([, s]) => s === "missing")).toEqual([]);
      for (const n of [group, ...inGroup]) expect(status[n.key], n.label).toBe("azure");
      expect(denyProblems(live)).toEqual([]);
    });
  }

  it("the orphan sweep and the safety net count the group as lab 28's, and no other lab's", () => {
    expect(ownsName(LAB, INFRA, LAB_IDS)).toBe(true);
    expect(labIdFromName(INFRA, LAB_IDS)).toBe(LAB);
    for (const other of LAB_IDS.filter((id) => id !== LAB)) expect(ownsName(other, INFRA, LAB_IDS), other).toBe(false);
  });
});
