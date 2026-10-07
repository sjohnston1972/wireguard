// topology-live-aks.test.ts: lab 29 (az305-29-aks), the AKS cluster, on the live diagram. The cluster is an `aks` card in
// its node subnet (placed by its agent pool's vnetSubnetID); its node scale set, in the node resource group Azure makes
// (rg-lab-<id>-nodes), folds into the cluster's card (the node pool); everything else in that group (the `kubernetes`
// load balancer, its outbound public IP, the NSG, the kubelet identity) and the group itself are "Made by Azure",
// never "Added by hand". Rows are shaped as Resource Graph returns them (Learn's REST reference for managedClusters;
// fake subscription, TEST-NET addresses), added to the lab's planned graph turned into rows.

import { describe, expect, it } from "vitest";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { diffGraphs } from "../../shared/topology/diff";
import { denyProblems } from "../../shared/topology/props";
import type { TopologyGraph, TopoNode } from "../../shared/topology/model";
import { liveCtxFor, plannedOf, roundTrip } from "./fixtures/topology/round-trip";
import { rowsCtx, rowsFromPlanned, SUB } from "./fixtures/topology/rows-from-planned";

const LAB = "az305-29-aks";
const RG = `rg-lab-${LAB}`;
const NODES = `${RG}-nodes`;
const prefix = rowsCtx(LAB).prefix;
const clusterId = `${SUB}/resourceGroups/${RG}/providers/Microsoft.ContainerService/managedClusters/aks-lab`;
const subnetId = `${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/vnet-lab/subnets/snet-aks`;
const inNodes = (provider: string, name: string) => `${SUB}/resourceGroups/${NODES}/providers/${provider}/${name}`;
const vmssId = inNodes("Microsoft.Compute/virtualMachineScaleSets", "aks-system-31415926-vmss");
const lbId = inNodes("Microsoft.Network/loadBalancers", "kubernetes");
const pipId = inNodes("Microsoft.Network/publicIPAddresses", "0c7b2a1e-5d4f-4e3a-9b8c-7d6e5f4a3b2c");

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

/** What Azure makes in the node resource group for a one-node pool with outbound type loadBalancer. */
const nodeGroupRows: ArgRow[] = [
  row(`${SUB}/resourceGroups/${NODES}`, "microsoft.resources/subscriptions/resourcegroups", { managedBy: clusterId, properties: { provisioningState: "Succeeded" } }),
  row(vmssId, "microsoft.compute/virtualmachinescalesets", {
    sku: { name: "Standard_B2s", tier: "Standard", capacity: 1 },
    tags: { "aks-managed-poolName": "system", "aks-managed-orchestrator": "Kubernetes:1.33.3" },
    properties: {
      provisioningState: "Succeeded",
      orchestrationMode: "Uniform",
      virtualMachineProfile: {
        storageProfile: { osDisk: { osType: "Linux", diskSizeGB: 64, managedDisk: { storageAccountType: "Premium_LRS" } } },
        networkProfile: { networkInterfaceConfigurations: [{ name: "aks-system-31415926-vmss", properties: { primary: true, ipConfigurations: [{ name: "ipconfig1", properties: { subnet: { id: subnetId }, loadBalancerBackendAddressPools: [{ id: `${lbId}/backendAddressPools/kubernetes` }] } }] } }] },
      },
    },
  }),
  row(lbId, "microsoft.network/loadbalancers", {
    sku: { name: "Standard", tier: "Regional" },
    properties: {
      provisioningState: "Succeeded",
      frontendIPConfigurations: [{ id: `${lbId}/frontendIPConfigurations/0c7b2a1e`, name: "0c7b2a1e", properties: { publicIPAddress: { id: pipId } } }],
      backendAddressPools: [{ id: `${lbId}/backendAddressPools/kubernetes`, name: "kubernetes", properties: {} }],
      outboundRules: [{ id: `${lbId}/outboundRules/aksOutboundRule`, name: "aksOutboundRule", properties: { protocol: "All", frontendIPConfigurations: [{ id: `${lbId}/frontendIPConfigurations/0c7b2a1e` }], backendAddressPool: { id: `${lbId}/backendAddressPools/kubernetes` } } }],
    },
  }),
  row(pipId, "microsoft.network/publicipaddresses", { sku: { name: "Standard", tier: "Regional" }, properties: { provisioningState: "Succeeded", ipAddress: "203.0.113.29", publicIPAllocationMethod: "Static", ipConfiguration: { id: `${lbId}/frontendIPConfigurations/0c7b2a1e` } } }),
  row(inNodes("Microsoft.Network/networkSecurityGroups", "aks-agentpool-31415926-nsg"), "microsoft.network/networksecuritygroups"),
  row(inNodes("Microsoft.ManagedIdentity/userAssignedIdentities", "aks-lab-agentpool"), "microsoft.managedidentity/userassignedidentities", { properties: { principalId: "0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a", clientId: "1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b" } }),
];

const byLabel = (g: TopologyGraph, label: string): TopoNode => {
  const n = g.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}: ${g.nodes.map((x) => x.label).join(", ")}`);
  return n;
};
const parentLabel = (g: TopologyGraph, n: TopoNode) => g.nodes.find((x) => x.id === n.parent)?.label;

describe("live AKS (lab 29)", () => {
  const planned = plannedOf(LAB);
  const live = liveGraph([...rowsFromPlanned(planned), ...nodeGroupRows], liveCtxFor(LAB));

  it("the cluster is an aks card in its node subnet, with its tier, node size and count, and its identity edge", () => {
    const c = byLabel(live, "aks-lab");
    expect(c.kind).toBe("aks");
    expect(parentLabel(live, c)).toBe("snet-aks");
    expect(c.props).toMatchObject({ tier: "Free", size: "Standard_B2s", instances: 1 });
    expect(c.props.chips).toEqual(expect.arrayContaining(["Azure CNI Overlay", `node group ${NODES}`]));
    expect(live.edges.filter((e) => e.from === c.id && e.label === "identity").map((e) => live.nodes.find((n) => n.id === e.to)?.label)).toEqual([`id-${prefix}-aks`]);
  });

  it("the node scale set folds into the cluster's card: the node pool, not a card of its own", () => {
    expect(byLabel(live, "aks-lab").folded?.map((f) => f.label)).toEqual(["aks-system-31415926-vmss"]);
    expect(live.nodes.some((n) => n.label === "aks-system-31415926-vmss")).toBe(false);
  });

  it("the node resource group and everything else in it are made by Azure, never added by hand", () => {
    const group = byLabel(live, NODES);
    expect(group.madeBy).toBe("azure");
    const inGroup = live.nodes.filter((n) => n.parent === group.id);
    expect(inGroup.map((n) => n.label).sort()).toEqual(["aks-agentpool-31415926-nsg", "aks-lab-agentpool", "kubernetes"]);
    for (const n of inGroup) expect(n.madeBy, n.label).toBe("azure");
    const { status } = diffGraphs(planned, live);
    expect(Object.entries(status).filter(([, s]) => s === "added")).toEqual([]);
    expect(Object.entries(status).filter(([, s]) => s === "missing")).toEqual([]);
    expect(Object.values(status).filter((s) => s === "azure").length).toBe(4);
    expect(denyProblems(live)).toEqual([]);
  });

  it("the node group is Azure's because the cluster's nodeResourceGroup names it, with or without managedBy on its row", () => {
    const rows = nodeGroupRows.map((r) => (r.type === "microsoft.resources/subscriptions/resourcegroups" ? { ...r, managedBy: null } : r));
    const g = liveGraph([...rowsFromPlanned(planned), ...rows], liveCtxFor(LAB));
    const group = byLabel(g, NODES);
    expect(group.madeBy).toBe("azure");
    for (const n of g.nodes.filter((x) => x.parent === group.id)) expect(n.madeBy, n.label).toBe("azure");
    // Without the cluster naming it (a cluster row with no nodeResourceGroup) and no managedBy, it is the learner's.
    const unnamed = rowsFromPlanned(planned).map((r) => (r.type === "microsoft.containerservice/managedclusters" ? { ...r, properties: { ...r.properties, nodeResourceGroup: null } } : r));
    const g2 = liveGraph([...unnamed, ...rows], liveCtxFor(LAB));
    expect(byLabel(g2, NODES).madeBy).toBeUndefined();
  });

  it("round trip: planned → rows → live has no added and no missing node", () => {
    const r = roundTrip(LAB);
    expect({ added: r.added, missing: r.missing, deny: r.deny }).toEqual({ added: [], missing: [], deny: [] });
    const c = byLabel(r.live, "aks-lab");
    expect(parentLabel(r.live, c)).toBe("snet-aks");
  });
});
