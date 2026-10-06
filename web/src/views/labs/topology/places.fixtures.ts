// views/labs/topology/places.fixtures.ts
//
// Plain English: small, realistic diagrams of lab 6 for the placement tests
// (T2): the planned graph (slot 31's example addresses, as every planned file
// has), and what the live view of a running session answers: one resource
// added by hand (nsg-handmade), the private endpoint deleted, the Entra group
// not listed by the live view. Fake GUIDs; addresses as the lab slots give them.

import type { LabTopologyResponse } from "@shared/api";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import type { TopologyLayout, TopologyLayoutPage } from "@shared/topology/layout";
import { findByRole } from "@testing-library/react";
import { PLANNED_URLS } from "@/api/topology";

export const LAB = "az104-06-blob-security";
/** The URL the planned file is fetched from (the hashed asset; a plain path in tests). */
export const PLANNED_URL = PLANNED_URLS[LAB]!;
export const TOPOLOGY_API = `/api/v1/labs/${LAB}/topology`;
export const LAYOUT_API = `/api/v1/prefs/topology/${LAB}`;

const T = (a: string) => `tf:${a}`;
export const KEYS = {
  rg: "microsoft.resources/resourcegroups/rg-lab-az104-06-blob-security",
  vnet: "microsoft.network/virtualnetworks/vnet-lab",
  subnet: "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-endpoints",
  pe: "microsoft.network/privateendpoints/pe-{p}blob-blob",
  storage: "microsoft.storage/storageaccounts/{p}blob",
  zone: "microsoft.network/privatednszones/privatelink.blob.core.windows.net",
  nsg: "microsoft.network/networksecuritygroups/nsg-handmade",
  group: "terraform/azuread_group/lab-az104-06-blob-security-readers",
};

export function plannedGraph(): TopologyGraph {
  return {
    schema: 1,
    labId: LAB,
    version: 2,
    source: "planned",
    at: null,
    nodes: [
      { id: "lane/tenant", key: "lane/tenant", kind: "lane", label: "Tenant and Entra ID", props: {} },
      { id: T("azuread_group.readers"), key: KEYS.group, kind: "entraPrincipal", parent: "lane/tenant", label: "lab-az104-06-blob-security-readers", props: {} },
      { id: T("azurerm_private_dns_zone.blob"), key: KEYS.zone, kind: "privateDnsZone", parent: T("azurerm_resource_group.lab"), label: "privatelink.blob.core.windows.net", props: {} },
      { id: T("azurerm_private_endpoint.blob"), key: KEYS.pe, kind: "privateEndpoint", parent: T("azurerm_subnet.endpoints"), label: "pe-l06…blob-blob", props: { groupId: "blob" } },
      { id: T("azurerm_resource_group.lab"), key: KEYS.rg, kind: "resourceGroup", label: "rg-lab-az104-06-blob-security", props: { region: "uksouth" } },
      { id: T("azurerm_storage_account.blob"), key: KEYS.storage, kind: "storage", parent: T("azurerm_resource_group.lab"), label: "l06…blob", props: { sku: "Standard LRS" } },
      { id: T("azurerm_subnet.endpoints"), key: KEYS.subnet, kind: "subnet", parent: T("azurerm_virtual_network.lab"), label: "snet-endpoints", props: { prefix: "10.71.192.0/24" } },
      { id: T("azurerm_virtual_network.lab"), key: KEYS.vnet, kind: "vnet", parent: T("azurerm_resource_group.lab"), label: "vnet-lab", props: { addressSpace: ["10.71.192.0/20"] } },
    ],
    edges: [
      { id: "traffic:pe>st", from: T("azurerm_private_endpoint.blob"), to: T("azurerm_storage_account.blob"), kind: "traffic", label: "blob", via: T("azurerm_private_endpoint.blob") },
    ],
  };
}

const RG = "/subscriptions/00000000-0000-4000-8000-000000000000/resourcegroups/rg-lab-az104-06-blob-security";
const P = `${RG}/providers`;
export const LIVE_IDS = {
  rg: RG,
  vnet: `${P}/microsoft.network/virtualnetworks/vnet-lab`,
  subnet: `${P}/microsoft.network/virtualnetworks/vnet-lab/subnets/snet-endpoints`,
  storage: `${P}/microsoft.storage/storageaccounts/l06k3x9qblob`,
  zone: `${P}/microsoft.network/privatednszones/privatelink.blob.core.windows.net`,
  nsg: `${P}/microsoft.network/networksecuritygroups/nsg-handmade`,
};

/** The live graph: the private endpoint is gone and an NSG was made by hand. `subnetProps` lets a test change a chip. */
export function liveGraph(subnetProps: Record<string, string> = { prefix: "10.64.0.0/24" }): TopologyGraph {
  const nodes: TopoNode[] = [
    { id: LIVE_IDS.rg, key: KEYS.rg, kind: "resourceGroup", label: "rg-lab-az104-06-blob-security", props: {} },
    { id: LIVE_IDS.vnet, key: KEYS.vnet, kind: "vnet", parent: LIVE_IDS.rg, label: "vnet-lab", props: { addressSpace: ["10.64.0.0/20"] }, health: { tone: "ok", word: "Ready" } },
    { id: LIVE_IDS.subnet, key: KEYS.subnet, kind: "subnet", parent: LIVE_IDS.vnet, label: "snet-endpoints", props: subnetProps },
    { id: LIVE_IDS.storage, key: KEYS.storage, kind: "storage", parent: LIVE_IDS.rg, label: "l06k3x9qblob", props: { sku: "Standard LRS" }, health: { tone: "ok", word: "Ready" } },
    { id: LIVE_IDS.zone, key: KEYS.zone, kind: "privateDnsZone", parent: LIVE_IDS.rg, label: "privatelink.blob.core.windows.net", props: {}, health: { tone: "ok", word: "Ready" } },
    { id: LIVE_IDS.nsg, key: KEYS.nsg, kind: "nsg", parent: LIVE_IDS.rg, label: "nsg-handmade", props: {}, health: { tone: "ok", word: "Ready" } },
  ];
  return {
    schema: 1,
    labId: LAB,
    version: 2,
    source: "live",
    at: "2026-10-02T12:00:00.000Z",
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: [],
  };
}

export const liveOk = (over: Partial<LabTopologyResponse> = {}): LabTopologyResponse => ({
  status: "ok",
  message: null,
  live: liveGraph(),
  fetchedAt: "2026-10-02T12:00:00.000Z",
  truncated: false,
  ...over,
});

export const liveDown = (status: "no_azure" | "failed" | "throttled", message: string): LabTopologyResponse => ({ status, message, live: null, fetchedAt: null, truncated: false });

export const layoutPage = (nodes: TopologyLayout["nodes"] = {}, version = 0): TopologyLayoutPage => ({ version, updatedAt: version ? "2026-10-02T11:00:00.000Z" : null, layout: { v: 1, nodes } });

/**
 * A fake of the Worker's two layout routes: GET answers the stored page, PUT
 * stores the layout when baseVersion matches (else 409 stale), as
 * worker/src/prefs.ts does. `puts` records every body sent.
 */
export function layoutServer(start: TopologyLayoutPage = layoutPage()) {
  const state = { page: start };
  const puts: { baseVersion: number; layout: TopologyLayout }[] = [];
  const routes: Record<string, unknown> = {
    [`GET ${LAYOUT_API}`]: () => state.page,
    [`PUT ${LAYOUT_API}`]: ({ body }: { body: { baseVersion: number; layout: TopologyLayout } }) => {
      puts.push(body);
      if (body.baseVersion !== state.page.version) return { status: 409, json: { error: { code: "stale", message: "Changed on another device." } } };
      state.page = { version: state.page.version + 1, updatedAt: "2026-10-02T12:01:00.000Z", layout: body.layout };
      return state.page;
    },
  };
  return { state, puts, routes };
}

// ── Finding the drawn diagram in a placement (T1's React Flow canvas) ────

/** The drawn diagram (the canvas's "Lab diagram" region) inside `el`, once it is on screen. */
export const diagramIn = (el: HTMLElement): Promise<HTMLElement> => findByRole(el, "region", { name: "Lab diagram" });

/** The node cards drawn on `diagram` whose accessible name matches (role group; the mini's cards have only the name). */
export function nodesOn(diagram: HTMLElement, name: RegExp): HTMLElement[] {
  return [...diagram.querySelectorAll<HTMLElement>(".react-flow__node[aria-label]")].filter((e) => name.test(e.getAttribute("aria-label")!));
}

/** The one node card drawn on `diagram` whose accessible name matches. */
export function nodeOn(diagram: HTMLElement, name: RegExp): HTMLElement {
  const hits = nodesOn(diagram, name);
  if (hits.length !== 1) throw new Error(`Expected one node named ${name} on the diagram, found ${hits.length}`);
  return hits[0]!;
}
