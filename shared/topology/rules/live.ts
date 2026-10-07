// shared/topology/rules/live.ts
//
// Plain English: what each Azure resource type becomes on a live diagram
// (lab topology spec §6.2, rulings 13-14). live.ts runs these rules over the
// Resource Graph rows of a lab's groups: a row is a card (of kindOfArm), a
// group (VNets and their subnets, virtual hubs), folded into another card (a
// VM's NIC and OS disk), or the maker of edges (peerings, route next hops,
// LB rules, private endpoint connections). Health comes from what the row
// already says (provisioningState, the VM power state, a few per-type
// statuses): no other call. AZURE_MADE lists what Azure makes by itself, so
// it is "Made by Azure", never "Added by hand". T3 extends these per family.
//
// Types are lower case (Resource Graph's `type` column).

import type { TopoHealth } from "../model";
import { aksNetworkWord, cosmosApi } from "./planned";

/** One Resource Graph row: the columns topologyQuery projects. */
export interface ArgRow {
  id: string;
  name: string;
  type: string;
  kind?: string | null;
  location?: string | null;
  resourceGroup: string;
  sku?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  zones?: string[] | null;
  identity?: Record<string, unknown> | null;
  managedBy?: string | null;
  properties?: Record<string, unknown> | null;
}

/** An edge a rule asks for, between ARM ids (lower case) or synthetic node ids. */
export interface LiveEdgeSpec {
  from: string;
  to: string;
  kind: "traffic" | "dependency";
  label?: string;
  via?: string;
  state?: TopoHealth;
  undirected?: boolean;
}

/** What live.ts offers the rules. */
export interface LiveHelpers {
  row(id: string): ArgRow | undefined;
  /** The node an ARM id ends up drawn as (itself, the card it folds into, a subnet), or null. */
  home(id: string): string | null;
  /** The node id of the asset whose private IP this is. */
  nodeByPrivateIp(ip: string): string | null;
  /** The NIC rows attached to a VM (by id). */
  nicsOf(vmId: string): ArgRow[];
  /** Every row (of the lab's groups) of a type, lower case. Optional so a rule's unit test can leave it out. */
  rowsOfType?(type: string): ArgRow[];
}

export interface ArmRule {
  /** The ARM id (any case) this row folds into, or null to be a card. */
  fold?: (row: ArgRow, h: LiveHelpers) => string | null | undefined;
  props?: (row: ArgRow, h: LiveHelpers) => Record<string, unknown>;
  edges?: (row: ArgRow, h: LiveHelpers) => LiveEdgeSpec[];
  /** A group's ARM id to place this card in, when the kind's placement cannot find it (a secured hub's firewall). */
  place?: (row: ArgRow, h: LiveHelpers) => string | null | undefined;
}

export const lower = (s: string | null | undefined): string => (s ?? "").toLowerCase();
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const idOf = (v: unknown): string | undefined => str(obj(v).id);
const props = (r: ArgRow) => obj(r.properties);

/** The top resource of an ARM id: "/subscriptions/s/resourceGroups/g/providers/ns/type/name" (a NIC's ipConfiguration → the NIC). */
export function topResource(id: string): string {
  const parts = id.split("/");
  // "", subscriptions, s, resourceGroups, g, providers, ns, type, name
  return parts.length > 9 ? parts.slice(0, 9).join("/") : id;
}

/** A subnet's id from any id under it (an ipConfiguration of a subnet is not a thing, but a trailing path may be). */
export function subnetIdOf(id: string): string | null {
  const m = /^(.*\/virtualnetworks\/[^/]+\/subnets\/[^/]+)/i.exec(id);
  return m ? m[1]! : null;
}

/** The name path of an ARM id: the names after the provider namespace (a subnet: [vnet, subnet]). */
export function namePathOf(id: string): string[] {
  const m = /\/providers\/[^/]+\/(.+)$/i.exec(id);
  if (!m) return [id.split("/").at(-1) ?? id];
  const segs = m[1]!.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i += 2) out.push(segs[i]!);
  return out;
}

const PROVISIONING: Record<string, TopoHealth> = {
  succeeded: { tone: "ok", word: "Ready" },
  failed: { tone: "bad", word: "Failed" },
  canceled: { tone: "bad", word: "Canceled" },
  updating: { tone: "warn", word: "Updating" },
  creating: { tone: "warn", word: "Creating" },
  deleting: { tone: "warn", word: "Deleting" },
  accepted: { tone: "warn", word: "Accepted" },
  provisioning: { tone: "warn", word: "Provisioning" },
  migrating: { tone: "warn", word: "Migrating" },
};

const POWER: Record<string, TopoHealth> = {
  running: { tone: "ok", word: "Running" },
  deallocated: { tone: "warn", word: "Stopped (deallocated)" },
  stopped: { tone: "warn", word: "Stopped" },
  starting: { tone: "warn", word: "Starting" },
  stopping: { tone: "warn", word: "Stopping" },
  deallocating: { tone: "warn", word: "Deallocating" },
};

/** A peering's, connection's or private endpoint approval's state as a health word. */
export function stateWord(s: string | undefined): TopoHealth | undefined {
  if (!s) return undefined;
  const k = s.toLowerCase();
  if (["connected", "approved", "succeeded", "online"].includes(k)) return { tone: "ok", word: s };
  if (k === "pending") return { tone: "warn", word: "Pending approval" };
  if (["initiated", "connecting", "updating", "degraded", "checkingendpoint"].includes(k)) return { tone: "warn", word: s };
  if (["disconnected", "rejected", "failed", "notconnected", "stopped", "inactive", "disabled"].includes(k)) return { tone: "bad", word: s };
  return { tone: "unknown", word: s };
}

/** Health without new calls (ruling 14): the VM power state, a few per-type statuses, else provisioningState. */
export function healthOf(row: ArgRow): TopoHealth {
  const p = props(row);
  const t = lower(row.type);
  if (t === "microsoft.compute/virtualmachines") {
    const code = str(obj(obj(obj(p.extended).instanceView).powerState).code);
    const k = code?.split("/")[1]?.toLowerCase();
    if (k && POWER[k]) return POWER[k]!;
  }
  if (t === "microsoft.sql/servers/databases" && str(p.status)) {
    const s = str(p.status)!;
    return { tone: s.toLowerCase() === "online" ? "ok" : ["paused", "pausing", "resuming", "scaling", "creating"].includes(s.toLowerCase()) ? "warn" : "bad", word: s };
  }
  if (t === "microsoft.network/connections" && str(p.connectionStatus)) return stateWord(str(p.connectionStatus))!;
  if (t === "microsoft.network/applicationgateways" && str(p.operationalState)) {
    const s = str(p.operationalState)!;
    return { tone: s.toLowerCase() === "running" ? "ok" : s.toLowerCase() === "stopped" ? "warn" : "unknown", word: s };
  }
  const ps = str(p.provisioningState);
  if (!ps) return { tone: "unknown", word: "No data" };
  return PROVISIONING[ps.toLowerCase()] ?? { tone: "unknown", word: ps };
}

/**
 * What Azure makes by itself (ruling 13): never "added by hand". Each entry
 * has a test (T3.7 adds one per pattern as families land).
 */
export const AZURE_MADE: { test(row: ArgRow): boolean; why: string }[] = [
  { why: "managed by another resource (managedBy set)", test: (r) => !!str(r.managedBy) },
  { why: "a VM's OS disk, named by Azure", test: (r) => lower(r.type) === "microsoft.compute/disks" && /_(osdisk|disk1)_/i.test(r.name) },
  { why: "a private endpoint's network interface", test: (r) => lower(r.type) === "microsoft.network/networkinterfaces" && (!!idOf(props(r).privateEndpoint) || /\.nic\.[0-9a-f-]{36}$/i.test(r.name)) },
  { why: "a group Azure made for a lab resource (rg-lab-<id>-infra and the like)", test: (r) => lower(r.type) === "microsoft.resources/resourcegroups" && /-(infra|managed|nodes)$/i.test(r.name) },
  // An AKS node group (rg-lab-<id>-nodes) or a Container Apps infrastructure group holds only what Azure made there.
  { why: "anything in a group Azure made for a lab resource (an AKS node group, a Container Apps infrastructure group)", test: (r) => lower(r.type) !== "microsoft.resources/resourcegroups" && /^rg-lab-.+-(infra|managed|nodes)$/i.test(r.resourceGroup ?? "") },
  { why: "traffic analytics' data collection rule or endpoint", test: (r) => /^microsoft\.insights\/datacollection(rules|endpoints)$/.test(lower(r.type)) && /^nwta/i.test(r.name) },
  { why: "a network watcher Azure made for the region", test: (r) => lower(r.type) === "microsoft.network/networkwatchers" && /^networkwatcher_/i.test(r.name) },
  { why: "a VNet peering Azure Virtual Network Manager made (ANM_…)", test: (r) => /\/virtualnetworkpeerings\/anm_[^/]*$/i.test(r.id) },
  { why: "a SQL server's master database", test: (r) => lower(r.type) === "microsoft.sql/servers/databases" && lower(r.name) === "master" },
];

/** VNet peerings as edges: one per pair (undirected), the gateway VNet as wg/gateway. */
function peeringEdges(row: ArgRow, gatewayIds: (id: string) => boolean): LiveEdgeSpec[] {
  const out: LiveEdgeSpec[] = [];
  for (const pe of arr(props(row).virtualNetworkPeerings)) {
    const pp = obj(pe.properties);
    const remote = idOf(pp.remoteVirtualNetwork);
    if (!remote) continue;
    const transit = pp.allowGatewayTransit === true || pp.useRemoteGateways === true;
    // AVNM's connectivity configuration makes its own peerings, named ANM_… (made by Azure, never by hand).
    const avnm = /\/virtualnetworkpeerings\/anm_[^/]*$/i.test(str(pe.id) ?? "") || /^anm_/i.test(str(pe.name) ?? "");
    out.push({ from: lower(row.id), to: gatewayIds(remote) ? "wg/gateway" : lower(remote), kind: "traffic", label: avnm ? "peering (AVNM)" : transit ? "peering (gateway transit)" : "peering", via: lower(str(pe.id) ?? ""), state: stateWord(str(pp.peeringState)), undirected: true });
  }
  return out;
}

/** The homes of an LB backend pool's members (NIC ipConfigurations → their VM). */
function poolMembers(pool: Record<string, unknown>, h: LiveHelpers): string[] {
  const out = new Set<string>();
  for (const c of arr(obj(pool.properties).backendIPConfigurations)) {
    const id = str(c.id);
    const home = id ? h.home(topResource(id)) : null;
    if (home) out.add(home);
  }
  // A Global-tier pool's members are regional LB frontends.
  for (const a of arr(obj(pool.properties).loadBalancerBackendAddresses)) {
    const fe = idOf(obj(a.properties).loadBalancerFrontendIPConfiguration);
    const home = fe ? h.home(topResource(fe)) : null;
    if (home) out.add(home);
  }
  return [...out].sort();
}

const nameOfId = (id: string | undefined) => (id ? id.split("/").at(-1) ?? id : undefined);

/** The resource whose public FQDN this is (a container group's, a public IP's DNS name, an App Service's host), by the rows. */
function byFqdn(fqdn: string, h: LiveHelpers): string | null {
  const f = lower(fqdn).replace(/\.$/, "");
  const types: [string, (r: ArgRow) => unknown][] = [
    ["microsoft.containerinstance/containergroups", (r) => obj(props(r).ipAddress).fqdn],
    ["microsoft.network/publicipaddresses", (r) => obj(props(r).dnsSettings).fqdn],
    ["microsoft.app/containerapps", (r) => obj(obj(props(r).configuration).ingress).fqdn],
  ];
  for (const [t, get] of types) for (const r of h.rowsOfType?.(t) ?? []) if (lower(str(get(r))) === f) return lower(r.id);
  return null;
}

/** Every ARM id inside a value, deep (as found, not lower-cased). */
function idsUnder(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (/^\/subscriptions\//i.test(v)) out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => idsUnder(x, out));
  else if (v && typeof v === "object") for (const x of Object.values(v)) idsUnder(x, out);
  return out;
}

const ipNum = (ip: string): number | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  return m ? ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]) : null;
};
/** Is an IPv4 address inside a CIDR? */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const a = ipNum(ip);
  const b = ipNum(base ?? "");
  const n = Number(bits);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
/** The subnet (of the lab's VNets) whose prefix holds an IP. */
function subnetHolding(ip: string, h: LiveHelpers): string | null {
  for (const v of h.rowsOfType?.("microsoft.network/virtualnetworks") ?? [])
    for (const s of arr(props(v).subnets)) {
      const sp = obj(s.properties);
      const prefixes = [str(sp.addressPrefix), ...((sp.addressPrefixes as string[] | undefined) ?? [])].filter((x): x is string => !!x);
      if (prefixes.some((c) => inCidr(ip, c))) return lower(str(s.id) ?? "");
    }
  return null;
}

/** A resource's user-assigned identities: resource → identity ("identity"). */
const identityEdges = (r: ArgRow): LiveEdgeSpec[] =>
  Object.keys(obj(obj(r.identity).userAssignedIdentities))
    .sort()
    .map((i) => ({ from: lower(r.id), to: lower(i), kind: "dependency" as const, label: "identity" }));

/** An alert: → each scope it watches ("alert"), → each action group it notifies. */
const alertEdges = (r: ArgRow, actionGroups: (string | undefined)[]): LiveEdgeSpec[] => [
  ...((props(r).scopes as string[] | undefined) ?? []).filter((s) => typeof s === "string").map((s) => ({ from: lower(r.id), to: lower(s), kind: "dependency" as const, label: "alert" })),
  ...actionGroups.filter((x): x is string => !!x).map((a) => ({ from: lower(r.id), to: lower(a), kind: "dependency" as const, label: "notifies" })),
];

/** A zone's own records: Resource Graph's numberOfRecordSets less the ones Azure makes (SOA, and NS for a public zone). */
const recordCounts = (r: ArgRow, made: number): string[] | undefined => {
  const n = props(r).numberOfRecordSets;
  return typeof n === "number" && n - made > 0 ? [`records: ${n - made}`] : undefined;
};

export const ARM_RULES: Record<string, ArmRule> = {
  "microsoft.network/networkinterfaces": {
    // A Private Link service's NIC (made by Azure) folds into the service: by the NIC's own link, else by the service's NIC list.
    fold: (r, h) =>
      idOf(props(r).virtualMachine) ??
      idOf(props(r).privateEndpoint) ??
      idOf(props(r).privateLinkService) ??
      (h.rowsOfType?.("microsoft.network/privatelinkservices") ?? []).find((s) => arr(props(s).networkInterfaces).some((n) => lower(str(n.id)) === lower(r.id)))?.id ??
      null,
  },
  // An ASG folds into the first member's VM (by NIC id), as the planned graph pulls it into the VM it is associated with.
  "microsoft.network/applicationsecuritygroups": {
    fold: (r, h) =>
      (h.rowsOfType?.("microsoft.network/networkinterfaces") ?? [])
        .filter((nic) => arr(props(nic).ipConfigurations).some((c) => arr(obj(c.properties).applicationSecurityGroups).some((a) => lower(str(a.id)) === lower(r.id))))
        .map((nic) => nic.id)
        .sort((a, b) => (lower(a) < lower(b) ? -1 : 1))[0] ?? null,
  },
  "microsoft.compute/disks": { fold: (r) => str(r.managedBy) ?? null },
  "microsoft.compute/virtualmachines/extensions": { fold: (r) => topResource(r.id) },
  "microsoft.network/networksecuritygroups": {
    fold: (r, h) => {
      const s = idOf(arr(props(r).subnets)[0]);
      if (s) return s;
      const nic = idOf(arr(props(r).networkInterfaces)[0]);
      return nic && h.home(nic) ? nic : null;
    },
    props: (r) => ({ counts: [`rules: ${arr(props(r).securityRules).length}`] }),
  },
  "microsoft.network/routetables": {
    fold: (r) => idOf(arr(props(r).subnets)[0]) ?? null,
    props: (r) => ({ counts: [`routes: ${arr(props(r).routes).length}`] }),
    edges: (r, h) => {
      const subnets = arr(props(r).subnets).map((s) => str(s.id)).filter((x): x is string => !!x).map(lower);
      const froms = subnets.length ? subnets : [lower(r.id)];
      const out: LiveEdgeSpec[] = [];
      for (const route of arr(props(r).routes)) {
        const rp = obj(route.properties);
        if (lower(str(rp.nextHopType)) !== "virtualappliance" || !str(rp.nextHopIpAddress)) continue;
        const to = h.nodeByPrivateIp(str(rp.nextHopIpAddress)!);
        if (!to) continue;
        for (const from of froms) out.push({ from, to, kind: "traffic", label: str(rp.addressPrefix) ?? "route", via: lower(str(route.id) ?? r.id) });
      }
      return out;
    },
  },
  "microsoft.network/publicipaddresses": {
    fold: (r) => {
      const c = idOf(props(r).ipConfiguration);
      return (c ? topResource(c) : undefined) ?? idOf(props(r).natGateway) ?? null;
    },
    props: (r) => ({ sku: str(obj(r.sku).name), publicIp: str(props(r).ipAddress), allocation: str(props(r).publicIPAllocationMethod) }),
  },
  // Like a public IP (ruling 9): a prefix a NAT gateway or an LB frontend uses folds into it.
  "microsoft.network/publicipprefixes": {
    fold: (r) => {
      const fe = idOf(props(r).loadBalancerFrontendIpConfiguration);
      return idOf(props(r).natGateway) ?? (fe ? topResource(fe) : null);
    },
    props: (r) => ({ prefix: str(props(r).ipPrefix) }),
  },
  "microsoft.network/natgateways": { props: (r) => ({ sku: str(obj(r.sku).name), zones: r.zones?.length ? r.zones : undefined }) },
  "microsoft.network/dnszones": { props: (r) => ({ counts: recordCounts(r, 2) }) },
  "microsoft.network/privatednszones": { props: (r) => ({ counts: recordCounts(r, 1) }) },
  // ── DNS private resolver: endpoints fold into it; the ruleset depends on the outbound endpoint (its resolver) ──
  "microsoft.network/dnsresolvers": {
    props: (r, h) => {
      const inbound = (h.rowsOfType?.("microsoft.network/dnsresolvers/inboundendpoints") ?? []).filter((e) => lower(topResource(e.id)) === lower(r.id));
      return { privateIp: inbound.map((e) => str(obj(arr(props(e).ipConfigurations)[0]).privateIpAddress)).find(Boolean) };
    },
  },
  "microsoft.network/dnsresolvers/inboundendpoints": { fold: (r) => topResource(r.id) },
  "microsoft.network/dnsresolvers/outboundendpoints": { fold: (r) => topResource(r.id) },
  "microsoft.network/dnsforwardingrulesets": {
    edges: (r) => arr(props(r).dnsResolverOutboundEndpoints).map((o) => str(o.id)).filter((x): x is string => !!x).map((o) => ({ from: lower(r.id), to: lower(o), kind: "dependency" as const, label: "outbound endpoint" })),
  },
  "microsoft.compute/virtualmachines": {
    // A flexible scale set's VM folds into the scale set (ruling 19).
    fold: (r) => idOf(props(r).virtualMachineScaleSet) ?? null,
    props: (r, h) => {
      const p = props(r);
      const nics = h.nicsOf(r.id);
      const nic = nics[0];
      const ip = nic ? str(obj(arr(props(nic).ipConfigurations)[0]?.properties).privateIPAddress) : undefined;
      // The NIC-level NSG and ASGs as chips, as the planned graph shows its associations.
      const chips = new Set<string>();
      for (const n of nics) {
        const nsg = idOf(props(n).networkSecurityGroup);
        if (nsg) chips.add(`NSG ${nameOfId(nsg)}`);
        for (const c of arr(props(n).ipConfigurations)) for (const a of arr(obj(c.properties).applicationSecurityGroups)) if (str(a.id)) chips.add(`ASG ${nameOfId(str(a.id))}`);
      }
      return { size: str(obj(p.hardwareProfile).vmSize), os: str(obj(obj(p.storageProfile).osDisk).osType), privateIp: ip, zones: r.zones?.length ? r.zones : undefined, chips: chips.size ? [...chips].sort() : undefined };
    },
    edges: (r) => identityEdges(r),
  },
  "microsoft.network/virtualnetworks": {
    props: (r) => ({ addressSpace: (obj(props(r).addressSpace).addressPrefixes as string[] | undefined) ?? [], dnsServers: (obj(props(r).dhcpOptions).dnsServers as string[] | undefined)?.length ? (obj(props(r).dhcpOptions).dnsServers as string[]) : undefined }),
    // A Virtual WAN hub connection shows on the spoke as a peering to the hub's Microsoft-managed VNet (HV_<hub>_<guid>): hub → spoke.
    edges: (r, h) =>
      arr(props(r).virtualNetworkPeerings).flatMap((pe) => {
        const remote = idOf(obj(pe.properties).remoteVirtualNetwork) ?? "";
        const m = /\/virtualnetworks\/hv_(.+)_[0-9a-f]{8}-[0-9a-f-]{27}$/i.exec(remote);
        const hub = m ? (h.rowsOfType?.("microsoft.network/virtualhubs") ?? []).find((x) => lower(x.name) === lower(m[1]) && lower(x.kind) !== "routeserver") : undefined;
        return hub ? [{ from: lower(hub.id), to: lower(r.id), kind: "traffic" as const, label: "hub connection", via: lower(str(pe.id) ?? r.id), state: stateWord(str(obj(pe.properties).peeringState)) }] : [];
      }),
  },
  "microsoft.network/loadbalancers": {
    props: (r) => {
      const fe = obj(arr(props(r).frontendIPConfigurations)[0]?.properties);
      // The planned graph says "Standard Global" for a global-tier LB and "Standard" for a regional one (its sku_tier is unset).
      const tier = lower(str(obj(r.sku).tier)) === "global" ? "Global" : undefined;
      return { sku: [str(obj(r.sku).name), tier].filter(Boolean).join(" ") || undefined, privateIp: str(fe.privateIPAddress) };
    },
    edges: (r, h) => {
      const pools = new Map(arr(props(r).backendAddressPools).map((p) => [lower(str(p.id)), p]));
      const out: LiveEdgeSpec[] = [];
      // A frontend chained to a Gateway LB: this LB → the gateway LB.
      for (const fe of arr(props(r).frontendIPConfigurations)) {
        const gw = idOf(obj(fe.properties).gatewayLoadBalancer);
        if (gw) out.push({ from: lower(r.id), to: lower(topResource(gw)), kind: "traffic", label: "chain", via: lower(str(fe.id) ?? r.id) });
      }
      for (const rule of arr(props(r).loadBalancingRules)) {
        const rp = obj(rule.properties);
        const label = lower(str(rp.protocol)) === "all" && !rp.frontendPort && !rp.backendPort ? "HA ports" : `${(str(rp.protocol) ?? "any").toUpperCase()} ${rp.frontendPort ?? "?"}→${rp.backendPort ?? "?"}`;
        const ids = [idOf(rp.backendAddressPool), ...arr(rp.backendAddressPools).map((x) => str(x.id))].filter((x): x is string => !!x);
        for (const pid of ids) for (const m of poolMembers(pools.get(lower(pid)) ?? {}, h)) out.push({ from: lower(r.id), to: m, kind: "traffic", label, via: lower(str(rule.id) ?? r.id) });
      }
      for (const nat of arr(props(r).inboundNatRules)) {
        const np = obj(nat.properties);
        const fp = np.frontendPort ?? (np.frontendPortRangeStart !== undefined ? `${np.frontendPortRangeStart}-${np.frontendPortRangeEnd}` : "?");
        const label = `${(str(np.protocol) ?? "any").toUpperCase()} ${fp}→${np.backendPort ?? "?"}`;
        const c = idOf(np.backendIPConfiguration);
        const targets = c ? [h.home(topResource(c))].filter((x): x is string => !!x) : idOf(np.backendAddressPool) ? poolMembers(pools.get(lower(idOf(np.backendAddressPool))) ?? {}, h) : [];
        for (const t of targets) out.push({ from: lower(r.id), to: t, kind: "traffic", label, via: lower(str(nat.id) ?? r.id) });
      }
      for (const ob of arr(props(r).outboundRules)) {
        const pid = idOf(obj(ob.properties).backendAddressPool);
        for (const m of pid ? poolMembers(pools.get(lower(pid)) ?? {}, h) : []) out.push({ from: m, to: lower(r.id), kind: "traffic", label: "outbound", via: lower(str(ob.id) ?? r.id) });
      }
      return out;
    },
  },
  "microsoft.network/privateendpoints": {
    props: (r, h) => {
      const c = [...arr(props(r).privateLinkServiceConnections), ...arr(props(r).manualPrivateLinkServiceConnections)][0];
      const nic = idOf(arr(props(r).networkInterfaces)[0]);
      const nicRow = nic ? h.row(nic) : undefined;
      const ip = nicRow ? str(obj(arr(props(nicRow).ipConfigurations)[0]?.properties).privateIPAddress) : str(obj(arr(props(r).customDnsConfigs)[0]).ipAddresses && (obj(arr(props(r).customDnsConfigs)[0]).ipAddresses as string[])[0]);
      return { groupId: ((obj(c?.properties).groupIds as string[] | undefined) ?? [])[0], privateIp: ip };
    },
    edges: (r) =>
      [...arr(props(r).privateLinkServiceConnections), ...arr(props(r).manualPrivateLinkServiceConnections)].flatMap((c) => {
        const cp = obj(c.properties);
        const target = str(cp.privateLinkServiceId);
        if (!target) return [];
        return [{ from: lower(r.id), to: lower(target), kind: "traffic" as const, label: ((cp.groupIds as string[] | undefined) ?? [])[0] ?? "private link", via: lower(str(c.id) ?? r.id), state: stateWord(str(obj(cp.privateLinkServiceConnectionState).status)) }];
      }),
  },
  // ── Application gateway and WAF policies (T3.2) ──
  "microsoft.network/applicationgateways": {
    props: (r) => {
      const p = props(r);
      const sku = obj(p.sku);
      const auto = obj(p.autoscaleConfiguration);
      const fe = arr(p.frontendIPConfigurations).map((x) => obj(x.properties)).find((x) => str(x.privateIPAddress));
      return {
        sku: str(sku.name),
        capacity: typeof auto.minCapacity === "number" ? `${auto.minCapacity}-${auto.maxCapacity ?? "?"}` : typeof sku.capacity === "number" ? sku.capacity : undefined,
        privateIp: str(fe?.privateIPAddress),
      };
    },
    // Request routing: listener (protocol, frontend port) → pool members (NIC configurations by their VM, addresses by IP), backend port.
    edges: (r, h) => {
      const p = props(r);
      const byId = (k: string) => new Map(arr(p[k]).map((x) => [lower(str(x.id)), obj(x.properties)]));
      const listeners = byId("httpListeners");
      const ports = byId("frontendPorts");
      const settings = byId("backendHttpSettingsCollection");
      const pools = byId("backendAddressPools");
      const out: LiveEdgeSpec[] = [];
      const rules = arr(p.requestRoutingRules).sort((a, b) => Number(obj(a.properties).priority ?? 0) - Number(obj(b.properties).priority ?? 0));
      for (const rule of rules) {
        const rp = obj(rule.properties);
        const pool = pools.get(lower(idOf(rp.backendAddressPool)));
        if (!pool) continue;
        const l = listeners.get(lower(idOf(rp.httpListener))) ?? {};
        const fp = ports.get(lower(idOf(l.frontendPort)))?.port;
        const bp = settings.get(lower(idOf(rp.backendHttpSettings)))?.port;
        const label = `${(str(l.protocol) ?? "any").toUpperCase()} ${fp ?? "?"}→${bp ?? "?"}`;
        const members = new Set<string>();
        for (const c of arr(pool.backendIPConfigurations)) {
          const home = str(c.id) ? h.home(topResource(str(c.id)!)) : null;
          if (home) members.add(home);
        }
        for (const a of arr(pool.backendAddresses)) {
          const n = str(a.ipAddress) ? h.nodeByPrivateIp(str(a.ipAddress)!) : null;
          if (n) members.add(n);
        }
        for (const m of [...members].sort()) out.push({ from: lower(r.id), to: m, kind: "traffic", label, via: lower(str(rule.id) ?? r.id) });
      }
      return [...out, ...identityEdges(r)];
    },
  },
  "microsoft.network/applicationgatewaywebapplicationfirewallpolicies": {
    props: (r) => ({ mode: str(obj(props(r).policySettings).mode) }),
    edges: (r) => arr(props(r).applicationGateways).map((a) => str(a.id)).filter((x): x is string => !!x).map((a) => ({ from: lower(r.id), to: lower(a), kind: "dependency" as const, label: "WAF policy" })),
  },
  "microsoft.network/frontdoorwebapplicationfirewallpolicies": {
    props: (r) => ({ mode: str(obj(props(r).policySettings).mode), sku: str(obj(r.sku).name) }),
    // Its security policy links name the Front Door profile (…/profiles/<p>/securityPolicies/<s>).
    edges: (r) => arr(props(r).securityPolicyLinks).map((s) => str(s.id)).filter((x): x is string => !!x).map((s) => ({ from: lower(r.id), to: lower(topResource(s)), kind: "dependency" as const, label: "WAF policy" })),
  },

  // ── Front Door (T3.2): the profile is the card; endpoints (listed) and origins (if listed: (V)) fold into it ──
  "microsoft.cdn/profiles": {
    props: (r, h) => ({
      sku: str(obj(r.sku).name),
      hostName: (h.rowsOfType?.("microsoft.cdn/profiles/afdendpoints") ?? []).filter((e) => lower(topResource(e.id)) === lower(r.id)).map((e) => str(props(e).hostName)).find(Boolean),
    }),
  },
  "microsoft.cdn/profiles/afdendpoints": { fold: (r) => topResource(r.id) },
  "microsoft.cdn/profiles/origingroups/origins": {
    fold: (r) => topResource(r.id),
    edges: (r, h) => {
      const p = props(r);
      const from = lower(topResource(r.id));
      const spl = obj(p.sharedPrivateLinkResource);
      const pls = idOf(spl.privateLink);
      if (pls) return [{ from, to: lower(pls), kind: "traffic", label: "Private Link", via: lower(r.id), state: stateWord(str(spl.status)) }];
      const host = str(p.hostName);
      const to = host ? (h.nodeByPrivateIp(host) ?? byFqdn(host, h)) : null;
      return to ? [{ from, to, kind: "traffic", label: "origin", via: lower(r.id) }] : [];
    },
  },

  // ── Traffic Manager (T3.2): endpoints are inline; each is an edge to its target (resource id, else FQDN) ──
  "microsoft.network/trafficmanagerprofiles": {
    props: (r) => ({ routing: str(props(r).trafficRoutingMethod) }),
    edges: (r, h) => {
      const method = lower(str(props(r).trafficRoutingMethod));
      return arr(props(r).endpoints).flatMap((ep) => {
        const ep_ = obj(ep.properties);
        const target = str(ep_.targetResourceId) ? lower(str(ep_.targetResourceId)) : str(ep_.target) ? byFqdn(str(ep_.target)!, h) : null;
        if (!target) return [];
        const label = method === "priority" && ep_.priority !== undefined ? `priority ${ep_.priority}` : method === "weighted" && ep_.weight !== undefined ? `weight ${ep_.weight}` : (str(props(r).trafficRoutingMethod) ?? "endpoint");
        return [{ from: lower(r.id), to: target, kind: "traffic" as const, label, via: lower(str(ep.id) ?? r.id), state: stateWord(str(ep_.endpointMonitorStatus)) }];
      });
    },
  },

  // ── Private Link service (T3.2/T3.4): → its LB; Azure's NIC folds into it ──
  "microsoft.network/privatelinkservices": {
    edges: (r) =>
      arr(props(r).loadBalancerFrontendIpConfigurations)
        .map((f) => str(f.id))
        .filter((x): x is string => !!x)
        .map((f) => ({ from: lower(r.id), to: lower(topResource(f)), kind: "traffic" as const, label: "frontend" })),
  },

  // ── Monitoring (T3.6) ──
  "microsoft.operationalinsights/workspaces": {
    props: (r) => {
      const cap = obj(props(r).workspaceCapping).dailyQuotaGb;
      return { retentionDays: props(r).retentionInDays, dailyCapGb: typeof cap === "number" && cap >= 0 ? cap : undefined };
    },
  },
  "microsoft.insights/metricalerts": { edges: (r) => alertEdges(r, arr(props(r).actions).map((a) => str(a.actionGroupId))) },
  "microsoft.insights/activitylogalerts": { edges: (r) => alertEdges(r, arr(obj(props(r).actions).actionGroups).map((a) => str(a.actionGroupId))) },
  "microsoft.insights/scheduledqueryrules": { edges: (r) => alertEdges(r, ((obj(props(r).actions).actionGroups as string[] | undefined) ?? []).map((a) => str(a))) },
  "microsoft.insights/datacollectionrules": {
    edges: (r) =>
      arr(obj(props(r).destinations).logAnalytics)
        .map((d) => str(d.workspaceResourceId))
        .filter((x): x is string => !!x)
        .map((w) => ({ from: lower(r.id), to: lower(w), kind: "dependency" as const, label: "sends to" })),
  },
  // A flow log (a Network Watcher child; normally in NetworkWatcherRG, outside the lab): what it watches, where it writes.
  "microsoft.network/networkwatchers/flowlogs": {
    props: (r) => ({ retentionDays: obj(props(r).retentionPolicy).enabled === false ? undefined : obj(props(r).retentionPolicy).days }),
    edges: (r) => {
      const p = props(r);
      const out: LiveEdgeSpec[] = [];
      const t = str(p.targetResourceId);
      if (t) out.push({ from: lower(r.id), to: lower(t), kind: "dependency", label: "watches" });
      const s = str(p.storageId);
      if (s) out.push({ from: lower(r.id), to: lower(s), kind: "dependency", label: "stores logs" });
      const fa = obj(obj(p.flowAnalyticsConfiguration).networkWatcherFlowAnalyticsConfiguration);
      const w = fa.enabled === false ? undefined : str(fa.workspaceResourceId);
      if (w) out.push({ from: lower(r.id), to: lower(w), kind: "dependency", label: "traffic analytics" });
      return out;
    },
  },
  "microsoft.network/bastionhosts": {
    props: (r) => ({ sku: str(obj(r.sku).name) }),
    // A Developer Bastion names its VNet, not a subnet.
    place: (r) => (arr(props(r).ipConfigurations).length ? null : (idOf(props(r).virtualNetwork) ?? null)),
  },

  // ── Compute (T3.5): scale sets as one card (ruling 19), autoscale and flexible VMs folded in ──
  "microsoft.compute/virtualmachinescalesets": {
    // An AKS node pool: a scale set in a cluster's node resource group folds into the cluster (lab 29).
    fold: (r, h) => (h.rowsOfType?.("microsoft.containerservice/managedclusters") ?? []).find((c) => lower(str(props(c).nodeResourceGroup)) === lower(r.resourceGroup))?.id ?? null,
    props: (r, h) => {
      const auto = (h.rowsOfType?.("microsoft.insights/autoscalesettings") ?? []).find((a) => lower(str(props(a).targetResourceUri)) === lower(r.id));
      const cap = obj(arr(auto ? props(auto).profiles : [])[0]?.capacity);
      const os = str(obj(obj(obj(props(r).virtualMachineProfile).storageProfile).osDisk).osType);
      return {
        size: str(obj(r.sku).name),
        os,
        instances: typeof obj(r.sku).capacity === "number" ? obj(r.sku).capacity : undefined,
        autoscale: cap.minimum !== undefined ? `${cap.minimum}-${cap.maximum ?? "?"}` : undefined,
        zones: r.zones?.length ? r.zones : undefined,
      };
    },
    edges: (r) => identityEdges(r),
    // Its NIC configurations' subnet (uniform); else the subnet of its VMs (flexible).
    place: (r, h) => {
      const sub = idsUnder(obj(props(r).virtualMachineProfile).networkProfile).map(subnetIdOf).find(Boolean);
      if (sub) return sub;
      const vms = (h.rowsOfType?.("microsoft.compute/virtualmachines") ?? []).filter((v) => lower(idOf(props(v).virtualMachineScaleSet)) === lower(r.id)).map((v) => lower(v.id));
      for (const nic of h.rowsOfType?.("microsoft.network/networkinterfaces") ?? [])
        if (vms.includes(lower(idOf(props(nic).virtualMachine)))) {
          const s = arr(props(nic).ipConfigurations).map((c) => subnetIdOf(idOf(obj(c.properties).subnet) ?? "")).find(Boolean);
          if (s) return s;
        }
      return null;
    },
  },
  "microsoft.insights/autoscalesettings": { fold: (r) => str(props(r).targetResourceUri) ?? null },
  "microsoft.recoveryservices/vaults": { props: (r) => ({ sku: str(obj(r.sku).name) }) },

  // ── Containers (T3.5) ──
  "microsoft.containerinstance/containergroups": {
    props: (r) => {
      const p = props(r);
      const req = arr(p.containers).map((c) => obj(obj(obj(c.properties).resources).requests));
      const sum = (k: string) => Math.round(req.reduce((a, x) => a + (typeof x[k] === "number" ? (x[k] as number) : 0), 0) * 100) / 100;
      const ip = obj(p.ipAddress);
      const type = lower(str(ip.type));
      return {
        cpu: req.length ? sum("cpu") : undefined,
        memoryGb: req.length ? sum("memoryInGB") : undefined,
        privateIp: type === "private" ? str(ip.ip) : undefined,
        publicIp: type === "public" ? str(ip.ip) : undefined,
        hostName: str(ip.fqdn),
        chips: type ? [type === "private" ? "private IP" : "public IP"] : ["no IP"],
      };
    },
    edges: (r) => identityEdges(r),
    place: (r) => idOf(arr(props(r).subnetIds)[0]) ?? null,
  },
  "microsoft.app/managedenvironments": {
    props: (r) => ({ sku: str(arr(props(r).workloadProfiles)[0]?.workloadProfileType) ?? "Consumption" }),
    place: (r) => str(obj(props(r).vnetConfiguration).infrastructureSubnetId) ?? null,
    // Its logs go to the workspace whose customer id it names.
    edges: (r, h) => {
      const customer = lower(str(obj(obj(props(r).appLogsConfiguration).logAnalyticsConfiguration).customerId));
      if (!customer) return [];
      return (h.rowsOfType?.("microsoft.operationalinsights/workspaces") ?? [])
        .filter((w) => lower(str(props(w).customerId)) === customer)
        .map((w) => ({ from: lower(r.id), to: lower(w.id), kind: "dependency" as const, label: "logs" }));
    },
  },
  // A job: its trigger as a chip; → each Service Bus namespace its KEDA rules watch (traffic, the queues' names).
  "microsoft.app/jobs": {
    props: (r) => {
      const cs = arr(obj(props(r).template).containers).map((c) => obj(c.resources));
      const trigger = lower(str(obj(props(r).configuration).triggerType));
      const chip = trigger === "event" ? "event-driven" : trigger === "schedule" ? "scheduled" : trigger === "manual" ? "manual" : undefined;
      return { cpu: cs.length ? Math.round(cs.reduce((a, c) => a + (typeof c.cpu === "number" ? c.cpu : 0), 0) * 100) / 100 : undefined, chips: chip ? [chip] : undefined };
    },
    edges: (r, h) => {
      const env = str(props(r).environmentId);
      const rules = arr(obj(obj(obj(props(r).configuration).eventTriggerConfig).scale).rules).filter((x) => lower(str(x.type)) === "azure-servicebus");
      const byNs = new Map<string, string[]>();
      for (const x of rules) {
        const md = obj(x.metadata);
        const ns = lower(str(md.namespace));
        const q = str(md.queueName) ?? str(md.topicName);
        if (ns && q) byNs.set(ns, [...(byNs.get(ns) ?? []), q]);
      }
      const namespaces = h.rowsOfType?.("microsoft.servicebus/namespaces") ?? [];
      return [
        ...[...byNs].flatMap(([ns, qs]) => namespaces.filter((n) => lower(n.name) === ns).map((n) => ({ from: lower(r.id), to: lower(n.id), kind: "traffic" as const, label: qs.join(", ") }))),
        ...(env ? [{ from: lower(r.id), to: lower(env), kind: "dependency" as const, label: "environment" }] : []),
        ...identityEdges(r),
      ];
    },
  },

  // ── Messaging and events (AZ-305 batch 4, lab 30): queues, topics and event subscriptions are not rows ──
  "microsoft.servicebus/namespaces": { props: (r) => ({ sku: str(obj(r.sku).name) }) },
  "microsoft.eventgrid/systemtopics": {
    edges: (r) => {
      const source = str(props(r).source);
      return source ? [{ from: lower(r.id), to: lower(source), kind: "dependency" as const, label: "source" }] : [];
    },
  },
  "microsoft.app/containerapps": {
    props: (r) => {
      const ing = obj(obj(props(r).configuration).ingress);
      return { ingress: Object.keys(ing).length ? (ing.external === true ? "external" : "internal") : undefined, targetPort: typeof ing.targetPort === "number" ? ing.targetPort : undefined };
    },
    edges: (r, h) => {
      const env = str(props(r).managedEnvironmentId) ?? str(props(r).environmentId);
      const servers = arr(obj(props(r).configuration).registries).map((x) => lower(str(x.server))).filter(Boolean);
      const regs = (h.rowsOfType?.("microsoft.containerregistry/registries") ?? []).filter((x) => servers.includes(lower(str(props(x).loginServer))));
      return [
        ...(env ? [{ from: lower(r.id), to: lower(env), kind: "dependency" as const, label: "environment" }] : []),
        ...regs.map((x) => ({ from: lower(r.id), to: lower(x.id), kind: "dependency" as const, label: "pulls images" })),
        ...identityEdges(r),
      ];
    },
  },
  "microsoft.containerregistry/registries": { props: (r) => ({ sku: str(obj(r.sku).name) }) },
  // AKS (lab 29): the cluster sits in its first pool's subnet; its node scale sets (in the node resource group) fold into it.
  "microsoft.containerservice/managedclusters": {
    props: (r) => {
      const pool = arr(props(r).agentPoolProfiles)[0] ?? {};
      const net = obj(props(r).networkProfile);
      const network = aksNetworkWord(str(net.networkPlugin), str(net.networkPluginMode));
      const nodeGroup = str(props(r).nodeResourceGroup);
      return {
        tier: str(obj(r.sku).tier),
        size: str(pool.vmSize),
        instances: typeof pool.count === "number" ? pool.count : undefined,
        autoscale: pool.enableAutoScaling === true && typeof pool.minCount === "number" ? `${pool.minCount}-${typeof pool.maxCount === "number" ? pool.maxCount : "?"}` : undefined,
        chips: [...(network ? [network] : []), ...(nodeGroup ? [`node group ${nodeGroup}`] : [])],
      };
    },
    edges: (r) => identityEdges(r),
    place: (r) => subnetIdOf(str(arr(props(r).agentPoolProfiles)[0]?.vnetSubnetID) ?? ""),
  },

  // ── Data (T3.4) ──
  "microsoft.network/serviceendpointpolicies": {
    fold: (r) => idOf(arr(props(r).subnets)[0]) ?? null,
    edges: (r) => {
      const subnets = arr(props(r).subnets).map((s) => str(s.id)).filter((x): x is string => !!x);
      const targets = arr(props(r).serviceEndpointPolicyDefinitions).flatMap((d) => ((obj(d.properties).serviceResources as string[] | undefined) ?? []).filter((x) => /^\/subscriptions\/[^/]+\/resourcegroups\//i.test(x)));
      return subnets.flatMap((s) => targets.map((t) => ({ from: lower(s), to: lower(t), kind: "dependency" as const, label: "service endpoint policy" })));
    },
  },
  "microsoft.sql/servers": { props: (r) => ({ publicAccess: str(props(r).publicNetworkAccess) ? lower(str(props(r).publicNetworkAccess)) !== "disabled" : undefined }) },
  "microsoft.sql/servers/databases": {
    // The master database Azure makes folds into its server.
    fold: (r) => (lower(r.name) === "master" ? topResource(r.id) : null),
    props: (r) => ({ status: str(props(r).status), sku: str(obj(r.sku).name) }),
    edges: (r) => [{ from: lower(r.id), to: lower(topResource(r.id)), kind: "dependency" as const, label: "server" }],
  },
  "microsoft.documentdb/databaseaccounts": {
    props: (r) => ({ apiKind: cosmosApi(str(r.kind), arr(props(r).capabilities).map((c) => str(c.name) ?? "")), consistency: str(obj(props(r).consistencyPolicy).defaultConsistencyLevel) }),
  },
  "microsoft.keyvault/vaults": {
    props: (r) => ({ sku: str(obj(props(r).sku).name), mode: props(r).enableRbacAuthorization === true ? "RBAC" : "access policies" }),
    // An access policy whose object id is a principal in the graph (a managed identity, a resource's own identity).
    edges: (r, h) => {
      const policies = arr(props(r).accessPolicies).map((p) => lower(str(p.objectId))).filter(Boolean);
      if (!policies.length) return [];
      const holders = new Map<string, string>();
      for (const t of ["microsoft.managedidentity/userassignedidentities", "microsoft.compute/virtualmachines", "microsoft.compute/virtualmachinescalesets", "microsoft.network/applicationgateways", "microsoft.containerinstance/containergroups", "microsoft.app/containerapps"])
        for (const x of h.rowsOfType?.(t) ?? []) {
          const pid = lower(str(props(x).principalId) ?? str(obj(x.identity).principalId));
          if (pid && !holders.has(pid)) holders.set(pid, lower(x.id));
        }
      return policies.map((p) => holders.get(p)).filter((x): x is string => !!x).map((from) => ({ from, to: lower(r.id), kind: "dependency" as const, label: "access policy" }));
    },
  },

  // ── VPN (T3.3) ──
  "microsoft.network/virtualnetworkgateways": {
    props: (r) => {
      const p = props(r);
      const bgp = p.enableBgp === true;
      const pool = (obj(obj(p.vpnClientConfiguration).vpnClientAddressPool).addressPrefixes as string[] | undefined) ?? [];
      return { sku: str(obj(p.sku).name), bgp, asn: bgp ? obj(p.bgpSettings).asn : undefined, vpnType: str(p.vpnType), clientPool: pool.length ? pool.join(", ") : undefined };
    },
  },
  "microsoft.network/localnetworkgateways": {
    props: (r) => ({ addressSpace: (obj(props(r).localNetworkAddressSpace).addressPrefixes as string[] | undefined) ?? [], asn: obj(props(r).bgpSettings).asn }),
    // The gateway whose public address it names (by the public IP row holding it).
    edges: (r, h) => {
      const ip = str(props(r).gatewayIpAddress);
      const pip = ip ? (h.rowsOfType?.("microsoft.network/publicipaddresses") ?? []).find((x) => str(props(x).ipAddress) === ip) : undefined;
      return pip ? [{ from: lower(r.id), to: lower(pip.id), kind: "dependency" as const, label: "gateway address" }] : [];
    },
  },
  "microsoft.network/connections": {
    fold: (r) => idOf(props(r).virtualNetworkGateway1) ?? null,
    edges: (r) => {
      const p = props(r);
      const gw = idOf(p.virtualNetworkGateway1);
      const to = idOf(p.localNetworkGateway2) ?? idOf(p.virtualNetworkGateway2) ?? idOf(p.peer);
      if (!gw || !to) return [];
      const t = lower(str(p.connectionType));
      const base = t === "vnet2vnet" ? "VNet-to-VNet" : t === "expressroute" ? "ExpressRoute" : "IPsec";
      return [{ from: lower(gw), to: lower(to), kind: "traffic" as const, label: p.enableBgp === true ? `${base}, BGP` : base, via: lower(r.id), state: stateWord(str(p.connectionStatus)) }];
    },
  },

  // ── Virtual hubs (T3.3): a Route Server (kind RouteServer) is a card placed by its router IPs; a vWAN hub is a group ──
  "microsoft.network/virtualhubs": {
    props: (r) => {
      const p = props(r);
      if (lower(r.kind) === "routeserver") return { asn: p.virtualRouterAsn, privateIp: ((p.virtualRouterIps as string[] | undefined) ?? [])[0], sku: str(p.sku) };
      return { prefix: str(p.addressPrefix), sku: str(p.sku) };
    },
    edges: (r) => {
      const wan = idOf(props(r).virtualWan);
      return wan ? [{ from: lower(wan), to: lower(r.id), kind: "dependency" as const, label: "virtual hub" }] : [];
    },
    // A Route Server row names no subnet; its router IPs sit in RouteServerSubnet.
    place: (r, h) => {
      if (lower(r.kind) !== "routeserver") return null;
      const ip = ((props(r).virtualRouterIps as string[] | undefined) ?? [])[0];
      return ip ? subnetHolding(ip, h) : null;
    },
  },
  "microsoft.network/virtualhubs/bgpconnections": {
    fold: (r) => topResource(r.id),
    edges: (r, h) => {
      const p = props(r);
      const to = str(p.peerIp) ? h.nodeByPrivateIp(str(p.peerIp)!) : null;
      return to ? [{ from: lower(topResource(r.id)), to, kind: "traffic" as const, label: `BGP ${p.peerAsn ?? ""}`.trim(), via: lower(r.id), state: stateWord(str(p.connectionState)) }] : [];
    },
  },
  "microsoft.network/virtualwans": { props: (r) => ({ sku: str(props(r).type) }) },

  // ── Firewall and policies (T3.3) ──
  "microsoft.network/azurefirewalls": {
    props: (r) => {
      const p = props(r);
      return { tier: str(obj(p.sku).tier), privateIp: str(obj(arr(p.ipConfigurations)[0]?.properties).privateIPAddress) ?? str(obj(p.hubIPAddresses).privateIPAddress) };
    },
    edges: (r) => {
      const fp = idOf(props(r).firewallPolicy);
      return fp ? [{ from: lower(r.id), to: lower(fp), kind: "dependency" as const, label: "policy" }] : [];
    },
    place: (r) => idOf(props(r).virtualHub) ?? null,
  },
  "microsoft.network/firewallpolicies": {
    props: (r) => {
      const n = arr(props(r).ruleCollectionGroups).length;
      return { tier: str(obj(props(r).sku).tier), counts: n ? [`rule collection groups: ${n}`] : undefined };
    },
    edges: (r) => {
      const base = idOf(props(r).basePolicy);
      return base ? [{ from: lower(base), to: lower(r.id), kind: "dependency" as const, label: "base policy" }] : [];
    },
  },

  // ── Virtual Network Manager (T3.3): its children are not rows; its peerings come as ANM_ (peeringEdges) ──
  "microsoft.network/networkmanagers": { props: (r) => ({ scopeAccess: (props(r).networkManagerScopeAccesses as string[] | undefined) ?? [] }) },

  "microsoft.network/privatednszones/virtualnetworklinks": {
    fold: (r) => topResource(r.id),
    edges: (r) => {
      const v = idOf(props(r).virtualNetwork);
      return v ? [{ from: lower(topResource(r.id)), to: lower(v), kind: "dependency" as const, label: props(r).registrationEnabled === true ? "link (auto-registration)" : "link", via: lower(r.id) }] : [];
    },
  },
  "microsoft.storage/storageaccounts": {
    // publicAccess is public network access (as planned: public_network_access_enabled), not anonymous blob access.
    props: (r) => ({ accountKind: str(r.kind), sku: str(obj(r.sku).name), accessTier: str(props(r).accessTier), publicAccess: str(props(r).publicNetworkAccess) ? lower(str(props(r).publicNetworkAccess)) !== "disabled" : undefined }),
    // The storage firewall's allowed subnets (service endpoints): subnet → account.
    edges: (r) =>
      arr(obj(props(r).networkAcls).virtualNetworkRules)
        .map((v) => str(v.id))
        .filter((x): x is string => !!x)
        .map((s) => ({ from: lower(s), to: lower(r.id), kind: "dependency" as const, label: "service endpoint" })),
  },
};

export { peeringEdges, nameOfId };
