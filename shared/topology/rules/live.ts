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
}

export interface ArmRule {
  /** The ARM id (any case) this row folds into, or null to be a card. */
  fold?: (row: ArgRow, h: LiveHelpers) => string | null | undefined;
  props?: (row: ArgRow, h: LiveHelpers) => Record<string, unknown>;
  edges?: (row: ArgRow, h: LiveHelpers) => LiveEdgeSpec[];
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
  if (["connected", "approved", "succeeded"].includes(k)) return { tone: "ok", word: s };
  if (k === "pending") return { tone: "warn", word: "Pending approval" };
  if (["initiated", "connecting", "updating"].includes(k)) return { tone: "warn", word: s };
  if (["disconnected", "rejected", "failed", "notconnected"].includes(k)) return { tone: "bad", word: s };
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
  { why: "a group Azure made for a lab resource (rg-lab-<id>-infra and the like)", test: (r) => lower(r.type) === "microsoft.resources/resourcegroups" && /-(infra|managed)$/i.test(r.name) },
  { why: "traffic analytics' data collection rule or endpoint", test: (r) => /^microsoft\.insights\/datacollection(rules|endpoints)$/.test(lower(r.type)) && /^nwta/i.test(r.name) },
  { why: "a network watcher Azure made for the region", test: (r) => lower(r.type) === "microsoft.network/networkwatchers" && /^networkwatcher_/i.test(r.name) },
];

/** VNet peerings as edges: one per pair (undirected), the gateway VNet as wg/gateway. */
function peeringEdges(row: ArgRow, gatewayIds: (id: string) => boolean): LiveEdgeSpec[] {
  const out: LiveEdgeSpec[] = [];
  for (const pe of arr(props(row).virtualNetworkPeerings)) {
    const pp = obj(pe.properties);
    const remote = idOf(pp.remoteVirtualNetwork);
    if (!remote) continue;
    const transit = pp.allowGatewayTransit === true || pp.useRemoteGateways === true;
    out.push({ from: lower(row.id), to: gatewayIds(remote) ? "wg/gateway" : lower(remote), kind: "traffic", label: transit ? "peering (gateway transit)" : "peering", via: lower(str(pe.id) ?? ""), state: stateWord(str(pp.peeringState)), undirected: true });
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
  return [...out].sort();
}

const nameOfId = (id: string | undefined) => (id ? id.split("/").at(-1) ?? id : undefined);

export const ARM_RULES: Record<string, ArmRule> = {
  "microsoft.network/networkinterfaces": {
    fold: (r) => idOf(props(r).virtualMachine) ?? idOf(props(r).privateEndpoint) ?? null,
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
  "microsoft.network/publicipprefixes": { fold: (r) => idOf(props(r).natGateway) ?? null, props: (r) => ({ prefix: str(props(r).ipPrefix) }) },
  "microsoft.compute/virtualmachines": {
    props: (r, h) => {
      const p = props(r);
      const nic = h.nicsOf(r.id)[0];
      const ip = nic ? str(obj(arr(props(nic).ipConfigurations)[0]?.properties).privateIPAddress) : undefined;
      return { size: str(obj(p.hardwareProfile).vmSize), os: str(obj(obj(p.storageProfile).osDisk).osType), privateIp: ip, zones: r.zones?.length ? r.zones : undefined };
    },
  },
  "microsoft.network/virtualnetworks": {
    props: (r) => ({ addressSpace: (obj(props(r).addressSpace).addressPrefixes as string[] | undefined) ?? [], dnsServers: (obj(props(r).dhcpOptions).dnsServers as string[] | undefined)?.length ? (obj(props(r).dhcpOptions).dnsServers as string[]) : undefined }),
  },
  "microsoft.network/loadbalancers": {
    props: (r) => {
      const fe = obj(arr(props(r).frontendIPConfigurations)[0]?.properties);
      return { sku: [str(obj(r.sku).name), str(obj(r.sku).tier)].filter(Boolean).join(" ") || undefined, privateIp: str(fe.privateIPAddress) };
    },
    edges: (r, h) => {
      const pools = new Map(arr(props(r).backendAddressPools).map((p) => [lower(str(p.id)), p]));
      const out: LiveEdgeSpec[] = [];
      for (const rule of arr(props(r).loadBalancingRules)) {
        const rp = obj(rule.properties);
        const label = `${(str(rp.protocol) ?? "any").toUpperCase()} ${rp.frontendPort ?? "?"}→${rp.backendPort ?? "?"}`;
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
  "microsoft.storage/storageaccounts": {
    props: (r) => ({ accountKind: str(r.kind), sku: str(obj(r.sku).name), accessTier: str(props(r).accessTier), publicAccess: typeof props(r).allowBlobPublicAccess === "boolean" ? props(r).allowBlobPublicAccess : undefined }),
  },
};

export { peeringEdges, nameOfId };
