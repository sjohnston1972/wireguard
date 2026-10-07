// shared/topology/live.ts
//
// Plain English: a running lab's live diagram (lab topology spec §6.2), from
// the rows of the one Resource Graph query (query.ts). Pure: the Worker
// fetches, this derives. Steps:
//
//   1. drop every row whose group is not the lab's own (ownsName, ruling 16),
//      so a longer lab id sharing the prefix never leaks in
//   2. groups: the resource groups the rows name, VNets with the subnets
//      their row lists, virtual hubs
//   3. folding (a NIC into its VM, an OS disk into its VM, an attached NSG or
//      route table into its subnet) by the ARM rules (rules/live.ts)
//   4. cards placed by kind: the subnet their properties name, the VNet,
//      their group, the Global lane; unknown types are generic cards
//   5. props (scrubbed: only PROP_NAMES), health (ruling 14), edges, the
//      WireGuard gateway node when a VNet is peered to it, "made by Azure"
//      (ruling 13), keys that match the planned graph's (ruling 6)
//
// Raw properties never leave: only scrubbed props, labels and ids do.

import { isGroupKind, TOPOLOGY_SCHEMA, sortGraph, type TopoEdge, type TopologyGraph, type TopoNode } from "./model";
import { KINDS, kindOfArm } from "./kinds";
import { disambiguate, nodeKey, SYNTHETIC_KEYS, type NameCtx } from "./keys";
import { scrubProps, withheldNote } from "./props";
import { ownsName } from "../labs";
import { ARM_RULES, AZURE_MADE, azureMadeGroups, healthOf, lower, namePathOf, peeringEdges, subnetIdOf, type ArgRow, type LiveEdgeSpec, type LiveHelpers } from "./rules/live";

export type { ArgRow };

export interface LiveCtx {
  labId: string;
  /** The session's lab version. */
  version: number;
  /** The session's name_prefix ("l06k3x9q"). */
  namePrefix: string;
  region: string;
  secondaryRegion: string | null;
  /** Every catalogue id (ownsName's longest-match rule). */
  catalogueIds: readonly string[];
  /** The gateway VNet's ARM id (vnet-wg), when known. */
  gatewayVnetId: string | null;
  /** The fetch time (ISO). */
  at: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every ARM id (lower case) inside a value, deep. */
function idsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (/^\/subscriptions\//i.test(v)) out.push(v.toLowerCase());
  } else if (Array.isArray(v)) v.forEach((x) => idsIn(x, out));
  else if (v && typeof v === "object") for (const x of Object.values(v)) idsIn(x, out);
  return out;
}

export function liveGraph(allRows: readonly ArgRow[], ctx: LiveCtx): TopologyGraph {
  const nameCtx: NameCtx = { prefix: ctx.namePrefix, region: ctx.region, secondaryRegion: ctx.secondaryRegion };
  const primaryRg = `rg-lab-${ctx.labId}`;
  const notes: string[] = [];

  // ── 1. Only the lab's own groups ──
  const owned = allRows.filter((r) => typeof r?.id === "string" && typeof r.resourceGroup === "string" && ownsName(ctx.labId, r.resourceGroup, ctx.catalogueIds)).sort((a, b) => cmp(lower(a.id), lower(b.id)));
  // A group's own row (resourcecontainers) only draws the group: an empty group is drawn too, never a card.
  // Told by its id's shape too (/subscriptions/<s>/resourceGroups/<name>, no provider), so an odd type never makes it a card.
  const isGroupOwnRow = (r: ArgRow) => lower(r.type) === "microsoft.resources/subscriptions/resourcegroups" || /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+$/i.test(r.id);
  const groupRows = owned.filter(isGroupOwnRow);
  const rows = owned.filter((r) => !isGroupOwnRow(r));
  const rowById = new Map(rows.map((r) => [lower(r.id), r]));
  // The groups Azure made, as this graph's rows name them (a cluster's node group, an environment's infrastructure
  // group, a group row with managedBy): never by name alone (ruling 13).
  const made = azureMadeGroups(owned);
  const nodes = new Map<string, TopoNode>();
  const raw = new Map<string, Record<string, unknown>>();
  const addNode = (n: TopoNode) => nodes.set(n.id, n);

  // ── 2. Groups ──
  const rgId = (r: ArgRow) => lower(r.id.split("/").slice(0, 5).join("/"));
  for (const r of [...groupRows, ...rows]) {
    const id = rgId(r);
    if (nodes.has(id)) continue;
    const name = r.resourceGroup;
    addNode({ id, key: "", kind: "resourceGroup", label: name, props: {}, armType: "Microsoft.Resources/resourceGroups", scope: "lab" });
    const role = lower(name).startsWith(`${primaryRg}-`) ? lower(name).slice(primaryRg.length + 1) : null;
    raw.set(id, role ? { chips: [role] } : {});
    if (AZURE_MADE.some((m) => m.test({ id, name, type: "microsoft.resources/resourcegroups", resourceGroup: name }, made))) nodes.get(id)!.madeBy = "azure";
  }
  const isGateway = (remote: string) => (ctx.gatewayVnetId ? lower(remote) === lower(ctx.gatewayVnetId) : false) || /\/virtualnetworks\/vnet-wg$/i.test(remote);
  const subnetPath = new Map<string, string[]>();
  for (const r of rows) {
    const t = lower(r.type);
    if (t === "microsoft.network/virtualnetworks") {
      const id = lower(r.id);
      addNode({ id, key: "", kind: "vnet", label: r.name, parent: rgId(r), props: {}, armType: r.type });
      for (const s of arr(obj(r.properties).subnets)) {
        const sid = lower(str(s.id) ?? `${r.id}/subnets/${str(s.name) ?? ""}`);
        const sp = obj(s.properties);
        const chips: string[] = [];
        const nsg = str(obj(sp.networkSecurityGroup).id);
        if (nsg) chips.push(`NSG ${nsg.split("/").at(-1)}`);
        const rt = str(obj(sp.routeTable).id);
        if (rt) chips.push(`route table ${rt.split("/").at(-1)}`);
        const nat = str(obj(sp.natGateway).id);
        if (nat) chips.push(`NAT gateway ${nat.split("/").at(-1)}`);
        const del = str(obj(arr(sp.delegations)[0]?.properties).serviceName);
        if (del) chips.push(`delegation ${del}`);
        const se = arr(sp.serviceEndpoints).map((x) => str(obj(x).service)).filter(Boolean);
        if (se.length) chips.push(`service endpoints ${se.join(", ")}`);
        if (sp.defaultOutboundAccess === false) chips.push("no default outbound");
        const prefix = str(sp.addressPrefix) ?? (Array.isArray(sp.addressPrefixes) ? str(sp.addressPrefixes[0]) : undefined);
        addNode({ id: sid, key: "", kind: "subnet", label: str(s.name) ?? sid.split("/").at(-1)!, parent: id, props: {}, armType: "Microsoft.Network/virtualNetworks/subnets" });
        raw.set(sid, { prefix, chips: chips.length ? chips : undefined });
        subnetPath.set(sid, [r.name, str(s.name) ?? ""]);
        if (nat) raw.set(`${sid}#nat`, { to: lower(nat) });
      }
    } else if (t === "microsoft.network/virtualhubs" && lower(r.kind) !== "routeserver") {
      addNode({ id: lower(r.id), key: "", kind: "virtualHub", label: r.name, parent: rgId(r), props: {}, armType: r.type });
    }
  }

  // ── 3. Folding ──
  const groupTypes = new Set(["microsoft.network/virtualnetworks"]);
  const isGroupRow = (r: ArgRow) => groupTypes.has(lower(r.type)) || (lower(r.type) === "microsoft.network/virtualhubs" && lower(r.kind) !== "routeserver");
  const owner = new Map<string, string>(); // row id → owner ARM id (lower)
  const nicsByVm = new Map<string, ArgRow[]>();
  for (const r of rows) {
    if (lower(r.type) !== "microsoft.network/networkinterfaces") continue;
    const vm = str(obj(obj(r.properties).virtualMachine).id);
    if (vm) nicsByVm.set(lower(vm), [...(nicsByVm.get(lower(vm)) ?? []), r]);
  }
  let home: (id: string, seen?: Set<string>) => string | null = () => null;
  const helpers: LiveHelpers = {
    row: (id) => rowById.get(lower(id)),
    home: (id) => home(id),
    nodeByPrivateIp: (ip) => {
      for (const n of [...nodes.values()].sort((a, b) => cmp(a.id, b.id))) if (raw.get(n.id)?.privateIp === ip) return n.id;
      return null;
    },
    nicsOf: (vmId) => nicsByVm.get(lower(vmId)) ?? [],
    rowsOfType: (t) => rows.filter((r) => lower(r.type) === t),
  };
  for (const r of rows) {
    if (isGroupRow(r)) continue;
    const o = ARM_RULES[lower(r.type)]?.fold?.(r, helpers);
    if (!o) continue;
    const target = lower(o);
    if (target === lower(r.id)) continue;
    if (rowById.has(target) || nodes.has(target)) owner.set(lower(r.id), target);
  }
  home = (id: string, seen = new Set<string>()): string | null => {
    const k = lower(id);
    if (nodes.has(k) && !owner.has(k)) return k;
    const o = owner.get(k);
    if (o) {
      if (seen.has(k)) return null;
      seen.add(k);
      return home(o, seen);
    }
    if (rowById.has(k)) return k; // a card (made below)
    return null;
  };

  // ── 4. Cards and their place ──
  let globalLane: string | null = null;
  const lane = (): string => {
    if (!globalLane) {
      globalLane = "lane/global";
      addNode({ id: globalLane, key: SYNTHETIC_KEYS.globalLane, kind: "lane", label: "Global", props: {} });
    }
    return globalLane;
  };
  const cards = rows.filter((r) => !isGroupRow(r) && !owner.has(lower(r.id)));
  for (const r of cards) addNode({ id: lower(r.id), key: "", kind: kindOfArm(r.type, r.kind ?? null), label: r.name, props: {}, armType: r.type });

  const subnetsIn = (r: ArgRow): string[] => {
    const out = new Set<string>();
    const consider = (v: unknown) => {
      for (const id of idsIn(v)) {
        const s = subnetIdOf(id);
        if (s && nodes.get(s)?.kind === "subnet") out.add(s);
      }
    };
    const p = obj(r.properties);
    // Only where a resource's own placement is: its IP configurations and subnet, not what it points at.
    consider(p.subnet);
    consider(arr(p.ipConfigurations).map((c) => obj(c.properties).subnet));
    consider(arr(p.frontendIPConfigurations).map((c) => obj(c.properties).subnet));
    consider(arr(p.gatewayIPConfigurations).map((c) => obj(c.properties).subnet));
    if (lower(r.type) === "microsoft.compute/virtualmachines") for (const nic of nicsByVm.get(lower(r.id)) ?? []) consider(arr(obj(nic.properties).ipConfigurations).map((c) => obj(c.properties).subnet));
    if (!out.size && kindOfArm(r.type, r.kind ?? null) === "generic") consider(r.properties);
    return [...out].sort();
  };
  for (const r of cards) {
    const n = nodes.get(lower(r.id))!;
    const place = KINDS[n.kind].placement;
    let parent: string | null = null;
    if (n.kind === "loadBalancer") parent = lower(str(obj(r.sku).tier)) === "global" ? lane() : (subnetsIn(r)[0] ?? rgId(r));
    else if (n.kind === "wafPolicy" && lower(r.type).includes("frontdoor")) parent = lane();
    else if (place === "subnet" || n.kind === "generic") parent = subnetsIn(r)[0] ?? rgId(r);
    else if (place === "vnet") {
      const v = idsIn(obj(r.properties).virtualNetwork)[0] ?? (subnetsIn(r)[0] ? nodes.get(subnetsIn(r)[0]!)?.parent : undefined);
      parent = v && nodes.get(v)?.kind === "vnet" ? v : rgId(r);
    } else if (place === "global") parent = lane();
    else parent = rgId(r);
    // A rule may name a group the kind's placement cannot find (a secured hub's firewall, a Route Server by its IPs).
    const placed = ARM_RULES[lower(r.type)]?.place?.(r, helpers);
    if (placed && nodes.has(lower(placed)) && isGroupKind(nodes.get(lower(placed))!.kind)) parent = lower(placed);
    n.parent = parent;
  }

  // Folded lists.
  for (const r of rows) {
    const id = lower(r.id);
    if (!owner.has(id)) continue;
    const h = home(id);
    const n = h ? nodes.get(h) : undefined;
    if (n) (n.folded ??= []).push({ id, label: r.name, armType: r.type });
  }

  // ── 5. Props, health, edges ──
  for (const r of cards) {
    const id = lower(r.id);
    const p = ARM_RULES[lower(r.type)]?.props?.(r, helpers) ?? {};
    raw.set(id, { ...p, resourceId: r.id });
    const n = nodes.get(id)!;
    n.health = healthOf(r);
    if (AZURE_MADE.some((m) => m.test(r, made))) n.madeBy = "azure";
  }
  for (const r of rows) {
    if (!isGroupRow(r)) continue;
    const p = ARM_RULES[lower(r.type)]?.props?.(r, helpers) ?? {};
    raw.set(lower(r.id), { ...p, resourceId: r.id });
  }

  const edges = new Map<string, TopoEdge>();
  const addEdge = (spec: LiveEdgeSpec) => {
    let from = home(spec.from) ?? (nodes.has(spec.from) ? spec.from : null);
    let to = spec.to === "wg/gateway" ? "wg/gateway" : (home(spec.to) ?? (nodes.has(spec.to) ? spec.to : null));
    if (!from || !to || from === to) return;
    if (spec.undirected && to < from) [from, to] = [to, from];
    const id = `${spec.kind}:${from}>${to}:${spec.label ?? ""}`;
    if (edges.has(id)) return;
    edges.set(id, { id, from, to, kind: spec.kind, ...(spec.label ? { label: spec.label } : {}), ...(spec.via ? { via: spec.via } : {}), ...(spec.state ? { state: spec.state } : {}) });
  };
  // The gateway node exists before its edges are checked against nodes.
  const gatewayPeered = rows.some((r) => lower(r.type) === "microsoft.network/virtualnetworks" && arr(obj(r.properties).virtualNetworkPeerings).some((pe) => isGateway(str(obj(obj(pe.properties).remoteVirtualNetwork).id) ?? "")));
  if (gatewayPeered) addNode({ id: "wg/gateway", key: SYNTHETIC_KEYS.gateway, kind: "gateway", label: "WireGuard gateway VNet", props: {} });
  for (const r of rows) {
    const t = lower(r.type);
    if (t === "microsoft.network/virtualnetworks") for (const e of peeringEdges(r, isGateway)) addEdge(e);
    for (const e of ARM_RULES[t]?.edges?.(r, helpers) ?? []) addEdge(e);
  }
  // Subnet → NAT gateway.
  for (const [k, v] of raw) if (k.endsWith("#nat")) {
    raw.delete(k);
    addEdge({ from: k.slice(0, -4), to: String(v.to), kind: "traffic", label: "outbound" });
  }

  // Scrub.
  let withheld = 0;
  for (const n of nodes.values()) {
    const s = scrubProps(raw.get(n.id) ?? {});
    withheld += s.withheld;
    n.props = s.props;
  }

  // Keys.
  const rgOfNode = (n: TopoNode): string | null => {
    let cur: TopoNode | undefined = n;
    for (let d = 0; cur && d < 10; d++) {
      if (cur.kind === "resourceGroup") return cur.label;
      cur = cur.parent ? nodes.get(cur.parent) : undefined;
    }
    return null;
  };
  const keyed = [...nodes.values()].map((n) => {
    let key: string;
    if (n.kind === "lane" || n.kind === "gateway") key = n.key;
    else if (n.kind === "resourceGroup") key = nodeKey("Microsoft.Resources/resourceGroups", [n.label], nameCtx);
    else if (n.kind === "subnet") key = nodeKey("Microsoft.Network/virtualNetworks/subnets", subnetPath.get(n.id) ?? [n.label], nameCtx);
    else key = nodeKey(n.armType ?? "unknown", namePathOf(rowById.get(n.id)?.id ?? n.id), nameCtx);
    return { id: n.id, key, group: n.kind === "resourceGroup" ? null : rgOfNode(n) };
  });
  const keys = disambiguate(keyed, primaryRg);
  for (const n of nodes.values()) n.key = keys[n.id] ?? n.key;

  if (withheld) notes.push(withheldNote(withheld));

  const g: TopologyGraph = {
    schema: TOPOLOGY_SCHEMA,
    labId: ctx.labId,
    version: ctx.version,
    source: "live",
    at: ctx.at,
    nodes: [...nodes.values()].map((n) => {
      const out: TopoNode = { id: n.id, key: n.key, kind: n.kind, label: n.label, props: n.props };
      if (n.parent) out.parent = n.parent;
      if (n.armType !== undefined) out.armType = n.armType;
      if (n.kind !== "lane" && n.kind !== "gateway") out.scope = "lab";
      if (n.health) out.health = n.health;
      if (n.folded?.length) out.folded = n.folded;
      if (n.madeBy) out.madeBy = n.madeBy;
      return out;
    }),
    edges: [...edges.values()],
    ...(notes.length ? { notes } : {}),
  };
  return sortGraph(g);
}
