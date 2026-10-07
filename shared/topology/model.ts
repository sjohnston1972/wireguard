// shared/topology/model.ts
//
// Plain English: the shape of a lab's architecture diagram (lab topology spec
// §4.1). A graph is a strict tree of group nodes (resource groups, VNets,
// subnets, virtual hubs, the Global and Tenant lanes) holding asset nodes
// (VMs, load balancers, storage accounts ...), plus edges between nodes:
// traffic (solid, can carry a port label) and dependency (dashed). The same
// shape comes from the planned builder (offline, from a lab's Terraform) and
// the live builder (from Azure Resource Graph rows), so the app draws either
// and diff.ts can lay one over the other by node key.
//
// Graphs are sorted (nodes and edges by id) and carry no timestamp but a live
// graph's `at`, so a planned file is byte-stable.

export const TOPOLOGY_SCHEMA = 1;

export type TopoSource = "planned" | "live";

export const TOPO_GROUP_KINDS = ["resourceGroup", "vnet", "subnet", "virtualHub", "lane"] as const;
export type TopoGroupKind = (typeof TOPO_GROUP_KINDS)[number];

/** The asset kinds (spec §4.3), plus `gateway` (the WireGuard gateway VNet, a fixed synthetic node) and `generic`. */
export const TOPO_ASSET_KINDS = [
  "vm",
  "vmss",
  "publicIp",
  "publicIpPrefix",
  "natGateway",
  "loadBalancer",
  "appGateway",
  "wafPolicy",
  "firewall",
  "firewallPolicy",
  "vpnGateway",
  "localNetworkGateway",
  "bastion",
  "routeServer",
  "dnsResolver",
  "dnsRuleset",
  "dnsZone",
  "privateDnsZone",
  "privateEndpoint",
  "privateLinkService",
  "storage",
  "sqlServer",
  "sqlDatabase",
  "cosmos",
  "keyVault",
  "containerGroup",
  "containerApp",
  "containerAppEnv",
  "containerAppJob",
  "registry",
  "serviceBus",
  "eventGrid",
  "logAnalytics",
  "monitor",
  "flowLog",
  "frontDoor",
  "trafficManager",
  "recoveryVault",
  "networkManager",
  "virtualWan",
  "managedIdentity",
  "appServicePlan",
  "nsg",
  "routeTable",
  "managementGroup",
  "policy",
  "role",
  "entraPrincipal",
  "gateway",
  "generic",
] as const;
export type TopoAssetKind = (typeof TOPO_ASSET_KINDS)[number];

export type TopoKind = TopoGroupKind | TopoAssetKind;
export type TopoTone = "ok" | "warn" | "bad" | "unknown";

/** A health word with its tone: "Running", "Stopped", "Failed", "Pending approval", "No data". Never colour alone. */
export interface TopoHealth {
  tone: TopoTone;
  word: string;
}

export type TopoPropValue = string | number | boolean | string[];

export interface TopoFolded {
  id: string;
  label: string;
  armType: string | null;
}

export interface TopoNode {
  /** Unique in the graph: planned "tf:<address>", live the ARM id in lower case. */
  id: string;
  /** Stable across planned and live (ruling 6): "<arm type>/<name path>", lower case, {p} {r} {r2}. */
  key: string;
  kind: TopoKind;
  /** A group node's id; absent at the root. */
  parent?: string;
  /** The resource name as shown (planned: the mock prefix shown as "l06…"). */
  label: string;
  /** Only PROP_NAMES (props.ts). */
  props: Record<string, TopoPropValue>;
  armType?: string | null;
  /** "outside": a planned resource outside the lab's groups (lab 44's flow log in NetworkWatcherRG). */
  scope?: "lab" | "outside";
  /** Live only. */
  health?: TopoHealth;
  /** The sub-resources drawn inside this card (a VM's NICs and disks, an LB's rules ...). */
  folded?: TopoFolded[];
  /** Live only: Azure made it (a private endpoint's NIC, an infra group), so it is never "added by hand". */
  madeBy?: "azure";
}

export interface TopoEdge {
  id: string;
  from: string;
  to: string;
  kind: "traffic" | "dependency";
  /** "TCP 80→80", "0.0.0.0/0", "peering", "blob", "role: Reader". */
  label?: string;
  /** The resource that makes the edge (a peering, a connection, a route, a role assignment). */
  via?: string;
  /** Live: a peering's, connection's or private endpoint's state. */
  state?: TopoHealth;
}

export interface TopologyGraph {
  schema: 1;
  labId: string;
  /** The lab version: planned, lab.yaml's at generation; live, the session's labVersion. */
  version: number;
  source: TopoSource;
  /** Null for planned; the fetch time for live. */
  at: string | null;
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** Generator or derivation notes shown under the diagram ("2 resources of unknown type"). */
  notes?: string[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A copy with nodes and edges ordered by id, and each node's folded list by id. */
export function sortGraph(g: TopologyGraph): TopologyGraph {
  return {
    ...g,
    nodes: [...g.nodes].sort(byId).map((n) => (n.folded ? { ...n, folded: [...n.folded].sort(byId) } : n)),
    edges: [...g.edges].sort(byId),
  };
}

/** True for a group kind (a container on the canvas). */
export const isGroupKind = (k: TopoKind): k is TopoGroupKind => (TOPO_GROUP_KINDS as readonly string[]).includes(k);
