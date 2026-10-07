// rows-from-planned.ts: the round trip's helper (lab topology plan T3). rowsFromPlanned(graph) turns a lab's planned
// graph into the Resource Graph rows a running session of it would answer with, shaped as Learn's REST references show
// each type (ids, the properties that place a resource and make its edges), so liveGraph of them can be diffed with the
// planned graph: every planned node the live query can list must come back with the same key, and nothing may come
// back "added by hand".
//
// Honesty rules (integration review, "templates not tidier than Learn's shapes"):
//   - only types the Resource Graph `resources` table lists become rows (LISTED): tracked resources and the few
//     tracked children (subnets live inside their VNet row, peerings inside it too; NSG rules, routes, LB children,
//     storage containers, vault objects, role and policy objects, diagnostic settings never appear as rows);
//   - Azure's own rows come along: a VM's OS disk (managedBy), a private endpoint's NIC (named <pe>.nic.<guid>);
//   - names are the session's: the mock prefix becomes the session prefix, so keys must normalise back to {p}.

import type { TopologyGraph, TopoNode } from "../../../../shared/topology/model";
import type { ArgRow } from "../../../../shared/topology/rules/live";
import { KINDS } from "../../../../shared/topology/kinds";

export const SUB = "/subscriptions/00000000-0000-4000-8000-000000000000";

export interface RowsCtx {
  labId: string;
  /** The lab's two-digit number. */
  number: string;
  /** The session's name prefix (8 characters, lower case), not the mock one. */
  prefix: string;
  region: string;
  secondaryRegion: string;
}

export const rowsCtx = (labId: string): RowsCtx => {
  const number = /^az\d{3}-(\d{2})-/.exec(labId)?.[1] ?? "00";
  return { labId, number, prefix: `l${number}rt7xy`, region: "uksouth", secondaryRegion: "ukwest" };
};

/** ARM types (lower case) the `resources` table lists as rows of their own. */
export const LISTED = new Set(
  [
    "Microsoft.Network/virtualNetworks",
    "Microsoft.Network/networkInterfaces",
    "Microsoft.Network/networkSecurityGroups",
    "Microsoft.Network/applicationSecurityGroups",
    "Microsoft.Network/routeTables",
    "Microsoft.Network/publicIPAddresses",
    "Microsoft.Network/publicIPPrefixes",
    "Microsoft.Network/natGateways",
    "Microsoft.Network/loadBalancers",
    "Microsoft.Network/applicationGateways",
    "Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies",
    "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies",
    "Microsoft.Network/azureFirewalls",
    "Microsoft.Network/firewallPolicies",
    "Microsoft.Network/virtualNetworkGateways",
    "Microsoft.Network/localNetworkGateways",
    "Microsoft.Network/connections",
    "Microsoft.Network/bastionHosts",
    "Microsoft.Network/virtualHubs",
    "Microsoft.Network/virtualWans",
    "Microsoft.Network/dnsResolvers",
    "Microsoft.Network/dnsResolvers/inboundEndpoints",
    "Microsoft.Network/dnsResolvers/outboundEndpoints",
    "Microsoft.Network/dnsForwardingRulesets",
    "Microsoft.Network/dnszones",
    "Microsoft.Network/privateDnsZones",
    "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
    "Microsoft.Network/privateEndpoints",
    "Microsoft.Network/privateLinkServices",
    "Microsoft.Network/trafficManagerProfiles",
    "Microsoft.Network/networkManagers",
    "Microsoft.Network/networkWatchers",
    "Microsoft.Network/serviceEndpointPolicies",
    "Microsoft.Compute/virtualMachines",
    "Microsoft.Compute/virtualMachines/extensions",
    "Microsoft.Compute/virtualMachineScaleSets",
    "Microsoft.Compute/disks",
    "Microsoft.Storage/storageAccounts",
    "Microsoft.Sql/servers",
    "Microsoft.Sql/servers/databases",
    "Microsoft.DocumentDB/databaseAccounts",
    "Microsoft.KeyVault/vaults",
    "Microsoft.ContainerInstance/containerGroups",
    "Microsoft.App/containerApps",
    "Microsoft.App/managedEnvironments",
    "Microsoft.App/jobs",
    "Microsoft.ServiceBus/namespaces",
    "Microsoft.EventGrid/systemTopics",
    "Microsoft.ContainerRegistry/registries",
    "Microsoft.OperationalInsights/workspaces",
    "Microsoft.Insights/metricAlerts",
    "Microsoft.Insights/activityLogAlerts",
    "Microsoft.Insights/actionGroups",
    "Microsoft.Insights/dataCollectionRules",
    "Microsoft.Insights/autoscaleSettings",
    "Microsoft.Cdn/profiles",
    "Microsoft.Cdn/profiles/afdEndpoints",
    "Microsoft.RecoveryServices/vaults",
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    "Microsoft.Web/serverFarms",
  ].map((t) => t.toLowerCase()),
);

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const hex32 = (seed: string) => {
  let h = 2166136261;
  let out = "";
  for (let i = 0; out.length < 32; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % Math.max(seed.length, 1)) ^ i, 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 32);
};
const guid = (seed: string) => {
  const x = hex32(seed);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
};

/** Every row a running session of this planned graph answers with. */
export function rowsFromPlanned(g: TopologyGraph, ctx: RowsCtx = rowsCtx(g.labId)): ArgRow[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const mockPrefix = `l${ctx.number}k3x9q`;
  const shown = `l${ctx.number}…`;
  const real = (s: string) => s.split("{p}").join(ctx.prefix).split("{r2}").join(ctx.secondaryRegion).split("{r}").join(ctx.region).split(mockPrefix).join(ctx.prefix).split(shown).join(ctx.prefix);
  const primaryRg = `rg-lab-${g.labId}`;

  const rgOf = (n: TopoNode | undefined): string => {
    for (let cur = n, d = 0; cur && d < 12; d++) {
      if (cur.kind === "resourceGroup") return cur.label;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return primaryRg;
  };
  const outside = (n: TopoNode) => n.scope === "outside";
  /** The name path of a node, from its key (the key's type segments are its ARM type's). */
  const namesOf = (n: TopoNode): string[] => {
    const t = n.armType ?? "";
    const segs = n.key.replace(/#[^/]*$/, "").split("/").slice(t.split("/").length).map(real);
    // The key is lower case; the name keeps its case from the label (Azure keeps "RouteServerSubnet" as written).
    const own = real(n.label);
    if (segs.length && own.toLowerCase() === segs.at(-1)) segs[segs.length - 1] = own;
    return segs;
  };
  const armId = (rg: string, armType: string, names: string[]) => {
    const [ns, ...types] = armType.split("/");
    return `${SUB}/resourceGroups/${rg}/providers/${ns}/${types.map((t, i) => `${t}/${names[i] ?? names.at(-1)}`).join("/")}`;
  };
  const idOfNode = new Map<string, string>();
  const nodeArmId = (n: TopoNode): string | null => {
    if (idOfNode.has(n.id)) return idOfNode.get(n.id)!;
    if (!n.armType || n.key.startsWith("terraform/") || n.kind === "lane" || n.kind === "gateway") return null;
    const id = armId(rgOf(n), n.armType, namesOf(n));
    idOfNode.set(n.id, id);
    return id;
  };
  /** A folded entry's ARM id: a child of its home when its type is one, else a sibling in the home's group. */
  const foldedId = (home: TopoNode, f: { id: string; label: string; armType: string | null }): string | null => {
    if (!f.armType) return null;
    const homeId = nodeArmId(home);
    const name = real(f.label);
    const homeType = home.armType ?? "";
    if (homeId && lower(f.armType).startsWith(`${lower(homeType)}/`)) return `${homeId}/${f.armType.split("/").at(-1)}/${name}`;
    return armId(rgOf(home), f.armType, [name]);
  };

  const rows = new Map<string, ArgRow>();
  const base = (id: string, type: string, n: TopoNode | null, extra: Partial<ArgRow> = {}): ArgRow => {
    const segs = id.split("/");
    const row: ArgRow = {
      id,
      name: segs.at(-1)!,
      type: type.toLowerCase(),
      kind: "",
      location: n?.parent && byId.get(n.parent)?.kind === "lane" ? "global" : ctx.region,
      resourceGroup: segs[4]!,
      sku: null,
      tags: { lab: g.labId, project: "wg-admin-labs", session: "ls-0042" },
      zones: null,
      identity: null,
      managedBy: "",
      properties: { provisioningState: "Succeeded" },
      ...extra,
    };
    rows.set(lower(id), row);
    return row;
  };
  const P = (r: ArgRow) => r.properties as Record<string, unknown>;

  // Edges by node, for the properties that make them.
  const edgesFrom = (id: string) => g.edges.filter((e) => e.from === id);
  const edgesTo = (id: string) => g.edges.filter((e) => e.to === id);
  const subnetIdOf = (n: TopoNode): string | null => {
    if (n.kind !== "subnet") return null;
    const vnet = n.parent ? byId.get(n.parent) : undefined;
    const vid = vnet ? nodeArmId(vnet) : null;
    return vid ? `${vid}/subnets/${real(namesOf(n).at(-1) ?? n.label)}` : null;
  };
  const subnetOf = (n: TopoNode): string | null => (n.parent && byId.get(n.parent)?.kind === "subnet" ? subnetIdOf(byId.get(n.parent)!) : null);
  const vnetOf = (n: TopoNode): string | null => {
    const p = n.parent ? byId.get(n.parent) : undefined;
    if (p?.kind === "vnet") return nodeArmId(p);
    if (p?.kind === "subnet") return p.parent ? nodeArmId(byId.get(p.parent)!) : null;
    return null;
  };
  let ipSeq = 10;
  let pipSeq = 0;
  const ipFor = (n: TopoNode): string => (typeof n.props.privateIp === "string" ? n.props.privateIp : `10.71.${200 + (ipSeq % 50)}.${ipSeq++}`);
  const nicIds = new Map<string, string>(); // node id → its (first) NIC ipConfiguration id
  const folded = (n: TopoNode, armType: string) => (n.folded ?? []).filter((f) => lower(f.armType) === lower(armType));

  // ── Pass 1: every node and folded entry of a listed type becomes a row ──
  // The lab's groups answer from resourcecontainers (the query's union), each as its own row.
  for (const n of g.nodes) {
    if (n.kind !== "resourceGroup" || outside(n)) continue;
    const name = real(n.label);
    base(`${SUB}/resourceGroups/${name}`, "Microsoft.Resources/subscriptions/resourceGroups", n, { resourceGroup: name, properties: { provisioningState: "Succeeded" } });
  }
  for (const n of g.nodes) {
    if (outside(n) || n.kind === "subnet" || n.kind === "resourceGroup") continue;
    const id = nodeArmId(n);
    if (id && n.armType && LISTED.has(lower(n.armType))) base(id, n.armType, n);
    for (const f of n.folded ?? []) {
      if (!f.armType || !LISTED.has(lower(f.armType))) continue;
      const fid = foldedId(n, f);
      if (fid) base(fid, f.armType, null, { location: ctx.region });
    }
  }
  // A subnet's folded NSG, route table or NAT gateway, and a VM's folded NIC, are rows too (folded entries of groups).
  for (const n of g.nodes) {
    if (n.kind !== "subnet" || outside(n)) continue;
    for (const f of n.folded ?? []) {
      if (!f.armType || !LISTED.has(lower(f.armType))) continue;
      const fid = armId(rgOf(n), f.armType, [real(f.label)]);
      base(fid, f.armType, null);
    }
  }

  // ── Pass 2: properties per type ──
  const rowOf = (n: TopoNode) => {
    const id = nodeArmId(n);
    return id ? rows.get(lower(id)) : undefined;
  };
  const rowsOfType = (t: string) => [...rows.values()].filter((r) => r.type === t.toLowerCase());
  const foldedRow = (home: TopoNode, f: { label: string; armType: string | null }, inGroup = false) => {
    const fid = inGroup ? armId(rgOf(home), f.armType!, [real(f.label)]) : foldedId(home, { id: "", ...f });
    return fid ? rows.get(lower(fid)) : undefined;
  };

  // VMs: NICs (each with its subnet and IP), the OS disk Azure makes, data disks, extensions, power state.
  for (const n of g.nodes.filter((x) => x.kind === "vm" && !outside(x))) {
    const vm = rowOf(n);
    if (!vm) continue;
    Object.assign(P(vm), {
      hardwareProfile: { vmSize: n.props.size ?? "Standard_B1s" },
      storageProfile: { osDisk: { osType: n.props.os || "Linux", name: `${vm.name}_OsDisk_1_${hex32(vm.name)}`, managedDisk: { id: armId(vm.resourceGroup, "Microsoft.Compute/disks", [`${vm.name}_OsDisk_1_${hex32(vm.name)}`]) } } },
      extended: { instanceView: { powerState: { code: "PowerState/running", displayStatus: "VM running" } } },
    });
    if (Array.isArray(n.props.zones)) vm.zones = n.props.zones as string[];
    const disk = base(armId(vm.resourceGroup, "Microsoft.Compute/disks", [`${vm.name}_OsDisk_1_${hex32(vm.name)}`]), "Microsoft.Compute/disks", null, { managedBy: vm.id });
    Object.assign(P(disk), { osType: n.props.os || "Linux", diskState: "Attached" });
    const nicFs = folded(n, "Microsoft.Network/networkInterfaces");
    const asgs = (n.folded ?? []).filter((f) => lower(f.armType) === "microsoft.network/applicationsecuritygroups");
    nicFs.forEach((f, i) => {
      const nic = foldedRow(n, f, true);
      if (!nic) return;
      const ipc = `${nic.id}/ipConfigurations/ipconfig1`;
      if (i === 0) nicIds.set(n.id, ipc);
      Object.assign(P(nic), {
        virtualMachine: { id: vm.id },
        ipConfigurations: [{ id: ipc, name: "ipconfig1", properties: { privateIPAddress: i === 0 ? ipFor(n) : `10.71.250.${i}`, privateIPAllocationMethod: "Dynamic", subnet: subnetOf(n) ? { id: subnetOf(n) } : undefined, applicationSecurityGroups: asgs.map((a) => ({ id: armId(vm.resourceGroup, a.armType!, [real(a.label)]) })) } }],
      });
      const nsg = folded(n, "Microsoft.Network/networkSecurityGroups")[0];
      if (nsg) {
        const nsgRow = foldedRow(n, nsg, true);
        if (nsgRow) {
          P(nic).networkSecurityGroup = { id: nsgRow.id };
          P(nsgRow).networkInterfaces = [{ id: nic.id }];
        }
      }
    });
    if (!nicFs.length) {
      // A VM always has a NIC; a plan may have folded it elsewhere: make the one Azure would list.
      const nic = base(armId(vm.resourceGroup, "Microsoft.Network/networkInterfaces", [`nic-${vm.name}`]), "Microsoft.Network/networkInterfaces", null);
      const ipc = `${nic.id}/ipConfigurations/ipconfig1`;
      nicIds.set(n.id, ipc);
      Object.assign(P(nic), { virtualMachine: { id: vm.id }, ipConfigurations: [{ id: ipc, name: "ipconfig1", properties: { privateIPAddress: ipFor(n), subnet: subnetOf(n) ? { id: subnetOf(n) } : undefined } }] });
    }
    for (const f of folded(n, "Microsoft.Compute/disks")) {
      const d = foldedRow(n, f, true);
      if (d) {
        d.managedBy = vm.id;
        Object.assign(P(d), { diskSizeGB: 4, diskState: "Attached" });
      }
    }
    for (const f of folded(n, "Microsoft.Compute/virtualMachines/extensions")) {
      const x = foldedRow(n, f);
      if (x) Object.assign(P(x), { publisher: "Microsoft.Azure.Extensions", type: "CustomScript" });
    }
  }

  // Subnet-level NSGs, route tables (with routes from the next-hop edges) and NAT gateways.
  const subnetRefs = new Map<string, Record<string, unknown>>(); // subnet id → { networkSecurityGroup, routeTable, natGateway }
  for (const s of g.nodes.filter((x) => x.kind === "subnet" && !outside(x))) {
    const sid = subnetIdOf(s);
    if (!sid) continue;
    const refs: Record<string, unknown> = {};
    for (const f of s.folded ?? []) {
      const r = f.armType && LISTED.has(lower(f.armType)) ? foldedRow(s, f, true) : undefined;
      if (!r) continue;
      if (r.type === "microsoft.network/networksecuritygroups") {
        refs.networkSecurityGroup = { id: r.id };
        P(r).subnets = [...((P(r).subnets as unknown[]) ?? []), { id: sid }];
        P(r).securityRules ??= (s.folded ?? []).filter((x) => lower(x.armType) === "microsoft.network/networksecuritygroups/securityrules").map((x, i) => ({ id: `${r.id}/securityRules/${real(x.label)}`, name: real(x.label), properties: { priority: 100 + i, access: "Allow", direction: "Inbound", protocol: "Tcp" } }));
      }
      if (r.type === "microsoft.network/serviceendpointpolicies") {
        refs.serviceEndpointPolicies = [{ id: r.id }];
        P(r).subnets = [...((P(r).subnets as unknown[]) ?? []), { id: sid }];
        P(r).serviceEndpointPolicyDefinitions = [{ name: "allow", properties: { service: "Microsoft.Storage", serviceResources: edgesFrom(s.id).filter((e) => e.label === "service endpoint policy").map((e) => nodeArmId(byId.get(e.to)!)) } }];
      }
      if (r.type === "microsoft.network/routetables") {
        refs.routeTable = { id: r.id };
        P(r).subnets = [...((P(r).subnets as unknown[]) ?? []), { id: sid }];
        P(r).routes ??= edgesFrom(s.id)
          .filter((e) => e.kind === "traffic" && e.via && (s.folded ?? []).some((x) => x.id === e.via))
          .map((e) => ({ id: `${r.id}/routes/${(e.via ?? "").split(".").at(-1)}`, name: (e.via ?? "").split(".").at(-1), properties: { addressPrefix: e.label, nextHopType: "VirtualAppliance", nextHopIpAddress: byId.get(e.to)?.props.privateIp ?? "10.71.192.4" } }));
      }
    }
    for (const e of edgesFrom(s.id)) {
      const t = byId.get(e.to);
      if (t?.kind === "natGateway" && e.label === "outbound") refs.natGateway = { id: nodeArmId(t) };
    }
    const chips = strs(s.props.chips);
    const del = chips.find((c) => c.startsWith("delegation "));
    if (del) refs.delegations = [{ id: `${sid}/delegations/d0`, name: "d0", properties: { serviceName: del.slice("delegation ".length) } }];
    const se = chips.find((c) => c.startsWith("service endpoints "));
    if (se) refs.serviceEndpoints = se.slice("service endpoints ".length).split(", ").map((service) => ({ service, locations: [ctx.region] }));
    if (chips.includes("no default outbound")) refs.defaultOutboundAccess = false;
    subnetRefs.set(sid, refs);
  }

  // VNets: address space, subnets (with what is attached), peerings (one per direction, Connected).
  for (const v of g.nodes.filter((x) => x.kind === "vnet" && !outside(x))) {
    const row = rowOf(v);
    if (!row) continue;
    const subnets = g.nodes
      .filter((x) => x.kind === "subnet" && x.parent === v.id)
      .map((s) => {
        const sid = subnetIdOf(s)!;
        return { id: sid, name: sid.split("/").at(-1), properties: { provisioningState: "Succeeded", addressPrefix: s.props.prefix, ...(subnetRefs.get(sid) ?? {}) } };
      });
    const peerings = g.edges
      .filter((e) => e.label?.startsWith("peering") && (e.from === v.id || e.to === v.id))
      .map((e) => {
        const other = byId.get(e.from === v.id ? e.to : e.from);
        const remote = other ? nodeArmId(other) : null;
        const name = e.label === "peering (AVNM)" ? `ANM_${hex32(row.name).slice(0, 12).toUpperCase()}_${remote?.split("/").at(-1)}` : `peer-${row.name}-to-${remote?.split("/").at(-1)}`;
        return { id: `${row.id}/virtualNetworkPeerings/${name}`, name, properties: { peeringState: "Connected", peeringSyncLevel: "FullyInSync", allowForwardedTraffic: true, allowGatewayTransit: e.label?.includes("gateway transit") && e.from === v.id, useRemoteGateways: e.label?.includes("gateway transit") && e.to === v.id, remoteVirtualNetwork: { id: remote } } };
      });
    Object.assign(P(row), { addressSpace: { addressPrefixes: v.props.addressSpace ?? [] }, subnets, virtualNetworkPeerings: peerings, ...(v.props.dnsServers ? { dhcpOptions: { dnsServers: v.props.dnsServers } } : {}) });
  }

  // Public IPs and prefixes: folded ones name their owner, cards get an address.
  for (const n of g.nodes.filter((x) => !outside(x))) {
    for (const f of n.folded ?? []) {
      const t = lower(f.armType);
      if (t !== "microsoft.network/publicipaddresses" && t !== "microsoft.network/publicipprefixes") continue;
      const r = foldedRow(n, f, true);
      const owner = nodeArmId(n);
      if (!r || !owner) continue;
      if (n.kind === "natGateway") P(r).natGateway = { id: owner };
      else if (t === "microsoft.network/publicipprefixes") P(r).loadBalancerFrontendIpConfiguration = { id: `${owner}/frontendIPConfigurations/fe-${r.name}` };
      else {
        const child = n.kind === "loadBalancer" || n.kind === "appGateway" ? "frontendIPConfigurations" : "ipConfigurations";
        P(r).ipConfiguration = { id: `${owner}/${child}/ipconfig-${r.name}` };
        P(r).ipAddress = `203.0.113.${100 + (pipSeq++ % 150)}`;
      }
      r.sku = { name: "Standard", tier: n.props.sku === "Standard Global" ? "Global" : "Regional" };
    }
    if (n.kind === "publicIp" || n.kind === "publicIpPrefix") {
      const r = rowOf(n);
      if (r) Object.assign(P(r), n.kind === "publicIp" ? { ipAddress: "203.0.113.30", publicIPAllocationMethod: "Static" } : { ipPrefix: "203.0.113.32/31", prefixLength: 31 });
    }
  }

  // NAT gateways: their subnets.
  for (const n of g.nodes.filter((x) => x.kind === "natGateway" && !outside(x))) {
    const r = rowOf(n);
    if (!r) continue;
    r.sku = { name: "Standard" };
    P(r).subnets = edgesTo(n.id).filter((e) => byId.get(e.from)?.kind === "subnet").map((e) => ({ id: subnetIdOf(byId.get(e.from)!) }));
    P(r).idleTimeoutInMinutes = 4;
  }

  // Private DNS zones and their links; public zones.
  for (const n of g.nodes.filter((x) => (x.kind === "privateDnsZone" || x.kind === "dnsZone") && !outside(x))) {
    const r = rowOf(n);
    if (!r) continue;
    r.location = "global";
    P(r).numberOfRecordSets = 1 + Number(/records: (\d+)/.exec(strs(n.props.counts).join(" "))?.[1] ?? 0);
    for (const f of folded(n, "Microsoft.Network/privateDnsZones/virtualNetworkLinks")) {
      const l = foldedRow(n, f);
      const e = g.edges.find((x) => x.via === f.id);
      const target = e ? byId.get(e.to) : undefined;
      if (l) Object.assign(l, { location: "global" }) && Object.assign(P(l), { virtualNetwork: { id: target ? nodeArmId(target) : null }, registrationEnabled: !!e?.label?.includes("auto-registration"), virtualNetworkLinkState: "Completed" });
    }
  }

  // DNS private resolver, its endpoints and the forwarding ruleset.
  for (const n of g.nodes.filter((x) => x.kind === "dnsResolver" && !outside(x))) {
    const r = rowOf(n);
    if (!r) continue;
    P(r).virtualNetwork = { id: vnetOf(n) };
    for (const f of [...folded(n, "Microsoft.Network/dnsResolvers/inboundEndpoints"), ...folded(n, "Microsoft.Network/dnsResolvers/outboundEndpoints")]) {
      const x = foldedRow(n, f);
      if (!x) continue;
      const inbound = x.type.endsWith("/inboundendpoints");
      const sn = g.nodes.find((s) => s.kind === "subnet" && strs(s.props.chips).some((c) => c.includes("dnsResolvers")) && lower(s.label).includes(inbound ? "in" : "out"));
      const sid = sn ? subnetIdOf(sn) : null;
      Object.assign(P(x), inbound ? { ipConfigurations: [{ privateIpAddress: n.props.privateIp ?? "10.71.193.4", privateIpAllocationMethod: "Dynamic", subnet: { id: sid } }] } : { subnet: { id: sid } });
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === "dnsRuleset" && !outside(x))) {
    const r = rowOf(n);
    if (!r) continue;
    P(r).dnsResolverOutboundEndpoints = rowsOfType("microsoft.network/dnsresolvers/outboundendpoints").map((o) => ({ id: o.id }));
  }

  // Storage accounts: kind, SKU, tier, and the firewall's allowed subnets (from the service endpoint edges).
  for (const n of g.nodes.filter((x) => x.kind === "storage" && !outside(x))) {
    const r = rowOf(n);
    if (!r) continue;
    r.kind = typeof n.props.accountKind === "string" ? n.props.accountKind : "StorageV2";
    r.sku = { name: String(n.props.sku ?? "Standard LRS").replace(" ", "_"), tier: "Standard" };
    const rules = edgesTo(n.id).filter((e) => e.label === "service endpoint").map((e) => ({ id: subnetIdOf(byId.get(e.from)!), action: "Allow", state: "Succeeded" }));
    Object.assign(P(r), {
      accessTier: n.props.accessTier ?? "Hot",
      allowBlobPublicAccess: false,
      publicNetworkAccess: n.props.publicAccess === false ? "Disabled" : "Enabled",
      networkAcls: { bypass: "AzureServices", defaultAction: rules.length ? "Deny" : "Allow", virtualNetworkRules: rules, ipRules: [] },
      primaryEndpoints: { blob: `https://${r.name}.blob.core.windows.net/` },
    });
  }

  // The rest of the families add their templates below (T3.2-T3.6).
  extraTemplates({ g, byId, rows, rowOf, nodeArmId, subnetOf, subnetIdOf, vnetOf, foldedRow, folded, nicIds, ipFor, edgesFrom, edgesTo, armId, rgOf, real, base, ctx, guid, hex32 });

  return [...rows.values()].sort((a, b) => (lower(a.id) < lower(b.id) ? -1 : 1));
}

export interface TemplateKit {
  g: TopologyGraph;
  byId: Map<string, TopoNode>;
  rows: Map<string, ArgRow>;
  rowOf(n: TopoNode): ArgRow | undefined;
  nodeArmId(n: TopoNode): string | null;
  subnetOf(n: TopoNode): string | null;
  subnetIdOf(n: TopoNode): string | null;
  vnetOf(n: TopoNode): string | null;
  foldedRow(home: TopoNode, f: { label: string; armType: string | null }, inGroup?: boolean): ArgRow | undefined;
  folded(n: TopoNode, armType: string): { id: string; label: string; armType: string | null }[];
  nicIds: Map<string, string>;
  ipFor(n: TopoNode): string;
  edgesFrom(id: string): TopologyGraph["edges"];
  edgesTo(id: string): TopologyGraph["edges"];
  armId(rg: string, armType: string, names: string[]): string;
  rgOf(n: TopoNode | undefined): string;
  real(s: string): string;
  base(id: string, type: string, n: TopoNode | null, extra?: Partial<ArgRow>): ArgRow;
  ctx: RowsCtx;
  guid(seed: string): string;
  hex32(seed: string): string;
}

/** Family templates (T3.2-T3.6). */
function extraTemplates(k: TemplateKit): void {
  delivery(k);
  hybrid(k);
  compute(k);
}

/** T3.5: scale sets (and their autoscale rows), container apps and environments, registries, vaults. */
function compute(k: TemplateKit): void {
  const { g, byId, rowOf, nodeArmId, subnetOf, edgesFrom, folded, foldedRow } = k;
  for (const n of g.nodes.filter((x) => x.kind === "vmss" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    r.sku = { name: n.props.size ?? "Standard_B1s", tier: "Standard", capacity: Number(n.props.instances ?? 2) };
    Object.assign(P(r), {
      orchestrationMode: "Uniform",
      virtualMachineProfile: { storageProfile: { osDisk: { osType: n.props.os ?? "Linux" } }, networkProfile: { networkInterfaceConfigurations: [{ name: "nic", properties: { ipConfigurations: [{ name: "ipconfig1", properties: { subnet: { id: subnetOf(n) } } }] } }] } },
    });
    for (const f of folded(n, "Microsoft.Insights/autoscaleSettings")) {
      const a = foldedRow(n, f, true);
      const [min, max] = String(n.props.autoscale ?? "1-2").split("-");
      if (a) Object.assign(P(a), { enabled: true, targetResourceUri: r.id, profiles: [{ name: "default", capacity: { minimum: min, maximum: max, default: min } }] });
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === "containerAppEnv" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const sid = subnetOf(n);
    Object.assign(P(r), { workloadProfiles: [{ name: String(n.props.sku ?? "Consumption"), workloadProfileType: n.props.sku ?? "Consumption" }], ...(sid ? { vnetConfiguration: { infrastructureSubnetId: sid } } : {}) });
  }
  for (const n of g.nodes.filter((x) => x.kind === "containerApp" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const env = edgesFrom(n.id).find((e) => e.label === "environment");
    const reg = edgesFrom(n.id).find((e) => e.label === "pulls images");
    Object.assign(P(r), {
      managedEnvironmentId: env ? nodeArmId(byId.get(env.to)!) : null,
      configuration: { ingress: n.props.ingress ? { external: n.props.ingress === "external", targetPort: n.props.targetPort } : null, registries: reg ? [{ server: `${nodeArmId(byId.get(reg.to)!)?.split("/").at(-1)}.azurecr.io` }] : [] },
    });
  }
  for (const n of g.nodes.filter((x) => x.kind === "registry" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    r.sku = { name: n.props.sku ?? "Basic", tier: n.props.sku ?? "Basic" };
    P(r).loginServer = `${r.name}.azurecr.io`;
  }
  for (const n of g.nodes.filter((x) => x.kind === "recoveryVault" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (r) r.sku = { name: "RS0", tier: "Standard" };
  }
  // AZ-305 batch 4, lab 30: a job (Learn's Microsoft.App/jobs: environmentId, configuration.triggerType and
  // eventTriggerConfig.scale.rules[].metadata), a namespace (sku), a system topic (source), an environment's
  // workspace (appLogsConfiguration.logAnalyticsConfiguration.customerId against the workspace's customerId).
  for (const n of g.nodes.filter((x) => x.kind === "containerAppJob" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const env = edgesFrom(n.id).find((e) => e.label === "environment");
    const rules = edgesFrom(n.id)
      .filter((e) => e.kind === "traffic" && byId.get(e.to)?.kind === "serviceBus")
      .flatMap((e) => (e.label ?? "").split(", ").map((q) => ({ name: q, type: "azure-servicebus", metadata: { queueName: q, namespace: nodeArmId(byId.get(e.to)!)?.split("/").at(-1), messageCount: "1" } })));
    const trigger = (n.props.chips as string[] | undefined)?.[0];
    Object.assign(P(r), {
      environmentId: env ? nodeArmId(byId.get(env.to)!) : null,
      configuration: { triggerType: trigger === "scheduled" ? "Schedule" : trigger === "manual" ? "Manual" : "Event", eventTriggerConfig: { scale: { minExecutions: 0, maxExecutions: 2, rules } } },
      template: { containers: [{ name: "main", resources: { cpu: n.props.cpu ?? 0.25, memory: "0.5Gi" } }] },
    });
  }
  for (const n of g.nodes.filter((x) => x.kind === "serviceBus" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (r) r.sku = { name: String(n.props.sku ?? "Standard"), tier: String(n.props.sku ?? "Standard") };
  }
  for (const n of g.nodes.filter((x) => x.kind === "eventGrid" && x.scope !== "outside")) {
    const r = rowOf(n);
    const src = edgesFrom(n.id).find((e) => e.label === "source");
    if (r && src) Object.assign(P(r), { source: nodeArmId(byId.get(src.to)!), topicType: "Microsoft.Storage.StorageAccounts" });
  }
  for (const n of g.nodes.filter((x) => x.kind === "containerAppEnv" && x.scope !== "outside")) {
    const logs = edgesFrom(n.id).find((e) => e.label === "logs");
    const r = rowOf(n);
    const w = logs ? rowOf(byId.get(logs.to)!) : null;
    if (!r || !w) continue;
    const customerId = `7a6b5c4d-3e2f-4a1b-8c9d-${w.name.length.toString(16).padStart(12, "0")}`;
    P(w).customerId = customerId;
    P(r).appLogsConfiguration = { destination: "log-analytics", logAnalyticsConfiguration: { customerId } };
  }
}

/** T3.3: VPN gateways, local network gateways and connections, Route Server, firewalls and policies, vWAN, AVNM. */
function hybrid(k: TemplateKit): void {
  const { g, byId, rowOf, nodeArmId, subnetOf, edgesFrom, edgesTo, folded, foldedRow, rows } = k;
  const live = (n: { scope?: string }) => n.scope !== "outside";
  const rowIdOf = (id: string) => {
    const n = byId.get(id);
    return n ? nodeArmId(n) : null;
  };
  for (const n of g.nodes.filter((x) => x.kind === "vpnGateway" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    const pip = folded(n, "Microsoft.Network/publicIPAddresses").map((f) => foldedRow(n, f, true)).find(Boolean);
    Object.assign(P(r), {
      gatewayType: "Vpn",
      vpnType: n.props.vpnType ?? "RouteBased",
      sku: { name: n.props.sku ?? "VpnGw1AZ", tier: n.props.sku ?? "VpnGw1AZ" },
      enableBgp: n.props.bgp === true,
      ...(n.props.asn ? { bgpSettings: { asn: n.props.asn } } : {}),
      ...(n.props.clientPool ? { vpnClientConfiguration: { vpnClientAddressPool: { addressPrefixes: String(n.props.clientPool).split(", ") } } } : {}),
      ipConfigurations: [{ id: `${r.id}/ipConfigurations/gwipconfig`, name: "gwipconfig", properties: { subnet: { id: subnetOf(n) }, ...(pip ? { publicIPAddress: { id: pip.id } } : {}) } }],
    });
    for (const f of folded(n, "Microsoft.Network/connections")) {
      const c = foldedRow(n, f, true);
      const e = edgesFrom(n.id).find((x) => x.via === f.id);
      const to = e ? byId.get(e.to) : undefined;
      if (!c) continue;
      Object.assign(P(c), {
        connectionType: e?.label?.startsWith("VNet-to-VNet") ? "Vnet2Vnet" : "IPsec",
        connectionStatus: "Connected",
        enableBgp: !!e?.label?.includes("BGP"),
        virtualNetworkGateway1: { id: r.id },
        ...(to?.kind === "localNetworkGateway" ? { localNetworkGateway2: { id: nodeArmId(to) } } : to ? { virtualNetworkGateway2: { id: nodeArmId(to) } } : {}),
      });
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === "localNetworkGateway" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    const e = edgesFrom(n.id).find((x) => x.label === "gateway address");
    const gwId = e ? rowIdOf(e.to) : null;
    const pip = gwId ? [...rows.values()].find((x) => x.type === "microsoft.network/publicipaddresses" && String(P(x).ipConfiguration && (P(x).ipConfiguration as { id: string }).id).toLowerCase().startsWith(gwId.toLowerCase())) : undefined;
    Object.assign(P(r), { gatewayIpAddress: pip ? P(pip).ipAddress : "198.51.100.10", localNetworkAddressSpace: { addressPrefixes: n.props.addressSpace ?? [] }, ...(n.props.asn ? { bgpSettings: { asn: n.props.asn } } : {}) });
  }
  for (const n of g.nodes.filter((x) => x.kind === "routeServer" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    r.kind = "RouteServer";
    const sn = n.parent ? byId.get(n.parent) : undefined;
    const base = String(sn?.props.prefix ?? "10.71.199.0/27").split("/")[0]!.split(".");
    const ips = [4, 5].map((x) => [...base.slice(0, 3), String(Number(base[3]) + x)].join("."));
    Object.assign(P(r), { sku: "Standard", virtualRouterAsn: 65515, virtualRouterIps: ips, routingState: "Provisioned" });
  }
  for (const n of g.nodes.filter((x) => x.kind === "virtualHub" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    const wan = edgesTo(n.id).find((e) => e.label === "virtual hub");
    Object.assign(P(r), { addressPrefix: n.props.prefix, sku: n.props.sku ?? "Standard", ...(wan ? { virtualWan: { id: rowIdOf(wan.from) } } : {}), virtualRouterAsn: 65515 });
    // Each hub connection shows on its spoke as a peering to the hub's Microsoft-managed VNet.
    for (const e of edgesFrom(n.id).filter((x) => x.label === "hub connection")) {
      const spoke = rowOf(byId.get(e.to)!);
      if (!spoke) continue;
      const guid = k.guid(`${r.name}${spoke.name}`);
      const pe = { id: `${spoke.id}/virtualNetworkPeerings/RemoteVnetToHubPeering_${guid}`, name: `RemoteVnetToHubPeering_${guid}`, properties: { peeringState: "Connected", useRemoteGateways: true, remoteVirtualNetwork: { id: `/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/RG_${r.name}_${guid}/providers/Microsoft.Network/virtualNetworks/HV_${r.name}_${guid}` } } };
      P(spoke).virtualNetworkPeerings = [...((P(spoke).virtualNetworkPeerings as unknown[]) ?? []), pe];
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === "virtualWan" && live(x))) {
    const r = rowOf(n);
    if (r) P(r).type = n.props.sku ?? "Standard";
  }
  for (const n of g.nodes.filter((x) => x.kind === "firewall" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    const hub = n.parent && byId.get(n.parent)?.kind === "virtualHub" ? nodeArmId(byId.get(n.parent)!) : null;
    const pips = folded(n, "Microsoft.Network/publicIPAddresses").map((f) => foldedRow(n, f, true)).filter(Boolean);
    const policy = edgesFrom(n.id).find((e) => e.label === "policy");
    Object.assign(P(r), {
      sku: { name: hub ? "AZFW_Hub" : "AZFW_VNet", tier: n.props.tier ?? "Standard" },
      ...(hub
        ? { virtualHub: { id: hub }, hubIPAddresses: { privateIPAddress: "10.71.240.132", publicIPs: { count: 1 } } }
        : { ipConfigurations: [{ id: `${r.id}/azureFirewallIpConfigurations/ipconfig-data`, name: "ipconfig-data", properties: { privateIPAddress: n.props.privateIp ?? "10.71.199.4", subnet: { id: subnetOf(n) }, ...(pips[0] ? { publicIPAddress: { id: pips[0]!.id } } : {}) } }] }),
      ...(policy ? { firewallPolicy: { id: rowIdOf(policy.to) } } : {}),
    });
    // Folded public IPs point at the firewall's IP configurations (any name: the top resource is what counts).
  }
  for (const n of g.nodes.filter((x) => x.kind === "firewallPolicy" && live(x))) {
    const r = rowOf(n);
    if (!r) continue;
    const base = edgesTo(n.id).find((e) => e.label === "base policy");
    const groups = Number(/rule collection groups: (\d+)/.exec((n.props.counts as string[] | undefined)?.join(" ") ?? "")?.[1] ?? 0);
    Object.assign(P(r), { sku: { tier: n.props.tier ?? "Standard" }, ...(base ? { basePolicy: { id: rowIdOf(base.from) } } : {}), ruleCollectionGroups: Array.from({ length: groups }, (_, i) => ({ id: `${r.id}/ruleCollectionGroups/rcg-${i}` })) });
  }
  for (const n of g.nodes.filter((x) => x.kind === "networkManager" && live(x))) {
    const r = rowOf(n);
    if (r) P(r).networkManagerScopeAccesses = n.props.scopeAccess ?? [];
  }
}

const P = (r: ArgRow) => r.properties as Record<string, unknown>;
const parsePorts = (label: string | undefined) => {
  const m = /^(\w+) (\d+|\d+-\d+)→(\d+)$/.exec(label ?? "");
  if (label === "HA ports") return { protocol: "All", frontendPort: 0, backendPort: 0 };
  return m ? { protocol: m[1] === "ALL" ? "All" : m[1]![0] + m[1]!.slice(1).toLowerCase(), frontendPort: Number(m[2]!.split("-")[0]), backendPort: Number(m[3]) } : { protocol: "Tcp", frontendPort: 80, backendPort: 80 };
};

/** T3.2: load balancers (rules, NAT, outbound, global pools, chain), App Gateway, WAF policies, Front Door, Traffic Manager, PLS. */
function delivery(k: TemplateKit): void {
  const { g, byId, rowOf, nodeArmId, subnetOf, nicIds, edgesFrom, edgesTo, folded, foldedRow } = k;
  const memberConfig = (n: { id: string; kind: string } | undefined, lbId: string): Record<string, unknown> | null => {
    if (!n) return null;
    const ipc = nicIds.get(n.id);
    if (ipc) return { backendIPConfigurations: [{ id: ipc }] };
    const id = nodeArmId(byId.get(n.id)!);
    if (n.kind === "loadBalancer" && id) return { loadBalancerBackendAddresses: [{ name: id.split("/").at(-1), properties: { loadBalancerFrontendIPConfiguration: { id: `${id}/frontendIPConfigurations/fe-0` } } }] };
    if (n.kind === "vmss" && id) return { backendIPConfigurations: [{ id: `${id}/virtualMachines/0/networkInterfaces/nic-0/ipConfigurations/ipconfig1` }] };
    void lbId;
    return null;
  };
  for (const n of g.nodes.filter((x) => x.kind === "loadBalancer" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const global = String(n.props.sku ?? "").includes("Global");
    r.sku = { name: String(n.props.sku ?? "Standard").split(" ")[0], tier: global ? "Global" : "Regional" };
    if (global) r.location = k.ctx.region;
    const sid = subnetOf(n);
    const pips = folded(n, "Microsoft.Network/publicIPAddresses").map((f) => foldedRow(n, f, true)).filter(Boolean);
    const chain = edgesFrom(n.id).find((e) => e.label === "chain");
    const chainTo = chain ? nodeArmId(byId.get(chain.to)!) : null;
    const fe = `${r.id}/frontendIPConfigurations/fe-0`;
    P(r).frontendIPConfigurations = [
      { id: fe, name: "fe-0", properties: { ...(sid ? { subnet: { id: sid }, privateIPAddress: n.props.privateIp ?? "10.71.199.10", privateIPAllocationMethod: "Static" } : {}), ...(pips[0] ? { publicIPAddress: { id: pips[0]!.id } } : {}), ...(chainTo ? { gatewayLoadBalancer: { id: `${chainTo}/frontendIPConfigurations/fe-0` } } : {}) } },
    ];
    // One pool per rule edge set; rules, NAT rules and outbound rules from the planned edges' labels.
    const pool = `${r.id}/backendAddressPools/pool-0`;
    const members = new Map<string, Record<string, unknown>>();
    const rules: unknown[] = [];
    const nats: unknown[] = [];
    const outs: unknown[] = [];
    for (const e of edgesFrom(n.id).filter((x) => x.kind === "traffic" && x.label !== "chain")) {
      const t = byId.get(e.to);
      const mc = memberConfig(t, r.id);
      if (mc) members.set(e.to, mc);
      const ports = parsePorts(e.label);
      if (/\d+-\d+→/.test(e.label ?? "")) nats.push({ id: `${r.id}/inboundNatRules/nat-${nats.length}`, name: `nat-${nats.length}`, properties: { protocol: ports.protocol, frontendPortRangeStart: ports.frontendPort, frontendPortRangeEnd: Number(/-(\d+)→/.exec(e.label!)![1]), backendPort: ports.backendPort, backendAddressPool: { id: pool } } });
      else rules.push({ id: `${r.id}/loadBalancingRules/rule-${rules.length}`, name: `rule-${rules.length}`, properties: { ...ports, backendAddressPool: { id: pool } } });
    }
    for (const e of edgesTo(n.id).filter((x) => x.label === "outbound")) {
      const mc = memberConfig(byId.get(e.from), r.id);
      if (mc) members.set(e.from, mc);
      if (!outs.length) outs.push({ id: `${r.id}/outboundRules/outbound-0`, name: "outbound-0", properties: { protocol: "All", allocatedOutboundPorts: 1024, backendAddressPool: { id: pool }, frontendIPConfigurations: [{ id: fe }] } });
    }
    const merged: Record<string, unknown[]> = { backendIPConfigurations: [], loadBalancerBackendAddresses: [] };
    for (const m of members.values()) for (const [key, v] of Object.entries(m)) merged[key] = [...(merged[key] ?? []), ...(v as unknown[])];
    P(r).backendAddressPools = [{ id: pool, name: "pool-0", properties: merged }];
    P(r).loadBalancingRules = rules;
    P(r).inboundNatRules = nats;
    P(r).outboundRules = outs;
  }
  for (const n of g.nodes.filter((x) => x.kind === "appGateway" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const sid = subnetOf(n);
    const pips = folded(n, "Microsoft.Network/publicIPAddresses").map((f) => foldedRow(n, f, true)).filter(Boolean);
    const cap = String(n.props.capacity ?? "");
    const label = edgesFrom(n.id).find((e) => e.kind === "traffic")?.label ?? "HTTP 80→80";
    const [proto, fp, bp] = /^(\w+) (\d+)→(\d+)$/.exec(label)?.slice(1) ?? ["HTTP", "80", "80"];
    const members = edgesFrom(n.id).filter((e) => e.kind === "traffic").map((e) => nicIds.get(e.to)).filter((x): x is string => !!x).map((id) => ({ id }));
    const pip = pips[0] ? [{ id: `${r.id}/frontendIPConfigurations/fe-public`, name: "fe-public", properties: { publicIPAddress: { id: pips[0]!.id } } }] : [];
    Object.assign(P(r), {
      sku: { name: n.props.sku ?? "Standard_v2", tier: n.props.sku ?? "Standard_v2" },
      ...(cap.includes("-") ? { autoscaleConfiguration: { minCapacity: Number(cap.split("-")[0]), maxCapacity: Number(cap.split("-")[1]) } } : {}),
      operationalState: "Running",
      gatewayIPConfigurations: [{ id: `${r.id}/gatewayIPConfigurations/gw`, name: "gw", properties: { subnet: { id: sid } } }],
      frontendIPConfigurations: [...pip, ...(n.props.privateIp ? [{ id: `${r.id}/frontendIPConfigurations/fe-private`, name: "fe-private", properties: { privateIPAddress: n.props.privateIp, subnet: { id: sid } } }] : [])],
      frontendPorts: [{ id: `${r.id}/frontendPorts/p`, name: "p", properties: { port: Number(fp) } }],
      httpListeners: [{ id: `${r.id}/httpListeners/l`, name: "l", properties: { protocol: proto![0] + proto!.slice(1).toLowerCase(), frontendPort: { id: `${r.id}/frontendPorts/p` } } }],
      backendAddressPools: [{ id: `${r.id}/backendAddressPools/pool`, name: "pool", properties: { backendIPConfigurations: members, backendAddresses: [] } }],
      backendHttpSettingsCollection: [{ id: `${r.id}/backendHttpSettingsCollection/s`, name: "s", properties: { port: Number(bp), protocol: "Http" } }],
      requestRoutingRules: [{ id: `${r.id}/requestRoutingRules/rr`, name: "rr", properties: { priority: 100, httpListener: { id: `${r.id}/httpListeners/l` }, backendAddressPool: { id: `${r.id}/backendAddressPools/pool` }, backendHttpSettings: { id: `${r.id}/backendHttpSettingsCollection/s` } } }],
    });
    const ids = edgesFrom(n.id).filter((e) => e.label === "identity").map((e) => nodeArmId(byId.get(e.to)!)).filter((x): x is string => !!x);
    if (ids.length) r.identity = { type: "UserAssigned", userAssignedIdentities: Object.fromEntries(ids.map((i) => [i, { principalId: k.guid(i), clientId: k.guid(`${i}c`) }])) };
  }
  for (const n of g.nodes.filter((x) => x.kind === "wafPolicy" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const targets = edgesFrom(n.id).filter((e) => e.label === "WAF policy").map((e) => nodeArmId(byId.get(e.to)!)).filter((x): x is string => !!x);
    if (r.type.includes("frontdoor")) {
      r.location = "Global";
      Object.assign(P(r), { policySettings: { enabledState: "Enabled", mode: n.props.mode ?? "Prevention" }, securityPolicyLinks: targets.map((t) => ({ id: `${t}/securityPolicies/sp-0` })) });
    } else Object.assign(P(r), { policySettings: { state: "Enabled", mode: n.props.mode ?? "Prevention" }, applicationGateways: targets.map((id) => ({ id })) });
  }
  for (const n of g.nodes.filter((x) => x.kind === "frontDoor" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    r.location = "Global";
    r.sku = { name: n.props.sku ?? "Standard_AzureFrontDoor" };
    for (const f of folded(n, "Microsoft.Cdn/profiles/afdEndpoints")) {
      const e = foldedRow(n, f);
      if (e) Object.assign(e, { location: "Global" }) && Object.assign(P(e), { hostName: `${e.name}-abcdefgh.z01.azurefd.net`, enabledState: "Enabled" });
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === "trafficManager" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    r.location = "global";
    P(r).trafficRoutingMethod = n.props.routing ?? "Priority";
    P(r).endpoints = edgesFrom(n.id)
      .filter((e) => e.kind === "traffic")
      .map((e, i) => {
        const t = byId.get(e.to)!;
        const tid = nodeArmId(t);
        const m = /^(priority|weight) (\d+)$/.exec(e.label ?? "");
        return { id: `${r.id}/azureEndpoints/ep-${i}`, name: `ep-${i}`, type: "Microsoft.Network/trafficManagerProfiles/azureEndpoints", properties: { targetResourceId: tid, endpointStatus: "Enabled", endpointMonitorStatus: "Online", ...(m ? { [m[1]!]: Number(m[2]) } : {}) } };
      });
  }
  for (const n of g.nodes.filter((x) => x.kind === "privateLinkService" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const lbs = edgesFrom(n.id).filter((e) => e.label === "frontend").map((e) => nodeArmId(byId.get(e.to)!));
    const nic = k.base(k.armId(r.resourceGroup, "Microsoft.Network/networkInterfaces", [`${r.name}.nic.${k.guid(r.name)}`]), "Microsoft.Network/networkInterfaces", null);
    Object.assign(P(nic), { privateLinkService: { id: r.id }, ipConfigurations: [{ id: `${nic.id}/ipConfigurations/nat`, name: "nat", properties: { privateIPAddress: "10.71.198.4", subnet: { id: subnetOf(n) } } }] });
    Object.assign(P(r), { loadBalancerFrontendIpConfigurations: lbs.map((id) => ({ id: `${id}/frontendIPConfigurations/fe-0` })), ipConfigurations: [{ id: `${r.id}/ipConfigurations/nat`, name: "nat", properties: { subnet: { id: subnetOf(n) } } }], networkInterfaces: [{ id: nic.id }] });
  }
  for (const n of g.nodes.filter((x) => x.kind === "containerGroup" && x.scope !== "outside")) {
    const r = rowOf(n);
    if (!r) continue;
    const sid = subnetOf(n);
    Object.assign(P(r), {
      osType: "Linux",
      containers: [{ name: "web", properties: { image: "mcr.microsoft.com/azurelinux/base/python:3.12", resources: { requests: { cpu: Number(n.props.cpu ?? 0.5), memoryInGB: Number(n.props.memoryGb ?? 0.5) } } } }],
      ipAddress: sid ? { type: "Private", ip: "10.71.197.4" } : { type: "Public", ip: "203.0.113.70", fqdn: `${r.name}.${k.ctx.region}.azurecontainer.io` },
      ...(sid ? { subnetIds: [{ id: sid }] } : {}),
      instanceView: { state: "Running" },
    });
  }
}

/** Planned nodes the live query should list (a kind it lists, inside the lab's groups). */
export const listable = (n: TopoNode): boolean => n.kind !== "lane" && n.kind !== "gateway" && n.scope !== "outside" && KINDS[n.kind].liveVisible;
