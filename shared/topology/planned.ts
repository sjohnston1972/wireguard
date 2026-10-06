// shared/topology/planned.ts
//
// Plain English: a lab's planned diagram, made offline (lab topology spec §5
// step 3, rulings 1, 6-11, 24). The generator (scripts/labs-topology.mjs)
// runs the lab's Terraform as a plan with mocked providers and hands this
// pure function each resource's planned values (`changes`, scrubbed), the
// outputs it reads, and the HCL references between resources (`refs`, by
// configuration address and top-level attribute). The rules
// (rules/planned.ts) say what each type becomes; this file runs them:
//
//   1. instances (data sources and random_/time_ helpers left out; a
//      template deployment's resources expanded, armTemplate.ts)
//   2. groups: resource groups, VNets, subnets (and inline subnet blocks),
//      virtual hubs; a group outside the lab (NetworkWatcherRG) is "outside"
//   3. folding: what each sub-resource folds into (a NIC into its VM, an LB's
//      rules into the LB, an association's NSG into the subnet)
//   4. cards and their place: subnet, VNet, group, the Global or Tenant lane
//   5. props (only PROP_NAMES survive scrubProps), chips, edges, keys
//
// The result is sorted and holds no timestamp, so the same lab gives the
// same file byte for byte. Every resource is represented: a card, a folded
// entry, or the `via` of an edge.

import { isGroupKind, TOPOLOGY_SCHEMA, sortGraph, type TopoEdge, type TopoKind, type TopologyGraph, type TopoNode } from "./model";
import { KINDS, kindOfArm, kindOfTf } from "./kinds";
import { disambiguate, mockNameCtx, nodeKey, planLabel, SYNTHETIC_KEYS } from "./keys";
import { scrubProps, withheldNote } from "./props";
import { tfIgnored, tfRule, type EdgeSpec, type PlannedHelpers, type TfInst, type TfRule } from "./rules/planned";
import { expandDeployment } from "./armTemplate";

/** One entry of a plan's resource_changes, reduced and scrubbed (scripts/lib/topology-stream.mjs). */
export interface ResourceChange {
  address: string;
  type: string;
  name: string;
  index?: string | number | null;
  after: Record<string, unknown>;
  after_unknown?: unknown;
}

export interface PlannedInput {
  labId: string;
  /** lab.yaml's version. */
  version: number;
  /** The lab's two-digit number ("06"): the mock name prefix is l<number>k3x9q. */
  number: string;
  changes: ResourceChange[];
  /** The outputs the builder reads (PLAN_OUTPUTS); unknown ones null. */
  outputs: Record<string, unknown>;
  /** configuration address ("type.name", or "output.<name>") → top-level attribute → referenced configuration addresses. */
  refs: Record<string, Record<string, string[]>>;
}

const GROUP_TYPES: Record<string, TopoKind> = {
  azurerm_resource_group: "resourceGroup",
  azurerm_virtual_network: "vnet",
  azurerm_subnet: "subnet",
  azurerm_virtual_hub: "virtualHub",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const configOf = (address: string) => address.replace(/\[[^\]]*\]/g, "");

/** Every id a graph represents: its nodes, their folded entries and its edges' vias. */
export function representedIds(g: TopologyGraph): Set<string> {
  const out = new Set<string>();
  for (const n of g.nodes) {
    out.add(n.id);
    for (const f of n.folded ?? []) out.add(f.id);
  }
  for (const e of g.edges) if (e.via) out.add(e.via);
  return out;
}

export function plannedGraph(input: PlannedInput): TopologyGraph {
  const nameCtx = mockNameCtx(input.number);
  const primaryRg = `rg-lab-${input.labId}`;
  const notes: string[] = [];

  // ── 1. Instances ──
  const insts: TfInst[] = [];
  const rgLocation = new Map<string, string>();
  for (const c of input.changes) if (c.type === "azurerm_resource_group" && str(c.after?.name) && str(c.after?.location)) rgLocation.set(str(c.after.name)!.toLowerCase(), str(c.after.location)!);
  for (const c of [...input.changes].sort((a, b) => cmp(a.address, b.address))) {
    if (c.address.startsWith("data.") || tfIgnored(c.type)) continue;
    const inst: TfInst = { id: `tf:${c.address}`, address: c.address, config: configOf(c.address), type: c.type, name: c.name, index: c.index ?? null, after: c.after ?? {} };
    insts.push(inst);
    if (c.type === "azurerm_resource_group_template_deployment") {
      for (const r of expandDeployment(inst, rgLocation.get((str(inst.after.resource_group_name) ?? "").toLowerCase()) ?? nameCtx.region)) {
        const x: TfInst = { id: `${inst.id}/${r.type.toLowerCase()}/${r.name}`, address: `${c.address}/${r.type}/${r.name}`, config: "", type: "", name: r.name, index: null, after: { ...r.properties, name: r.name, resource_group_name: str(inst.after.resource_group_name), __arm: r }, armType: r.type };
        insts.push(x);
      }
    }
  }
  const byId = new Map(insts.map((i) => [i.id, i]));
  const byConfig = new Map<string, TfInst[]>();
  for (const i of insts) if (i.config) byConfig.set(i.config, [...(byConfig.get(i.config) ?? []), i]);

  const resolve = (from: TfInst, config: string): TfInst[] => {
    const targets = byConfig.get(config) ?? [];
    if (targets.length <= 1) return targets;
    const same = targets.filter((t) => t.index !== null && t.index === from.index);
    return same.length ? same : targets;
  };
  const refCache = new Map<string, TfInst[]>();
  const refs = (inst: TfInst, attrs?: string[]): TfInst[] => {
    const k = `${inst.id}|${attrs?.join(",") ?? "*"}`;
    const hit = refCache.get(k);
    if (hit) return hit;
    const table = inst.config ? (input.refs[inst.config] ?? {}) : {};
    const names = attrs ?? Object.keys(table).sort();
    const out: TfInst[] = [];
    for (const a of names) for (const cfg of table[a] ?? []) for (const t of resolve(inst, cfg)) if (t !== inst && !out.includes(t)) out.push(t);
    // Expanded template resources reference by ARM id (expandDeployment's dependsOn and property ids).
    const arm = (inst.after.__arm ?? null) as { refs?: string[] } | null;
    if (arm && !attrs) for (const r of arm.refs ?? []) for (const t of insts) if (t.armType && `${t.armType}/${t.name}`.toLowerCase() === r.toLowerCase() && !out.includes(t)) out.push(t);
    refCache.set(k, out);
    return out;
  };
  const referrers = (inst: TfInst, types?: string[], attrs?: string[]): TfInst[] =>
    insts.filter((r) => r !== inst && (!types || types.includes(r.type)) && refs(r, attrs).includes(inst));

  const ruleOf = (i: TfInst): TfRule => (i.armType ? {} : tfRule(i.type));
  const groupKindOf = (i: TfInst): TopoKind | null => {
    if (i.armType) {
      const k = kindOfArm(i.armType);
      return k === "vnet" || k === "virtualHub" ? k : null;
    }
    if (i.type === "azurerm_virtual_hub" && str(i.after.kind)?.toLowerCase() === "routeserver") return null;
    return GROUP_TYPES[i.type] ?? null;
  };
  const labelOf = (i: TfInst): string => planLabel(nameOf(i), input.number);
  const nameOf = (i: TfInst): string => str(i.after.name) ?? str(i.after.display_name) ?? (i.index !== null ? `${i.name}[${i.index}]` : i.name);

  // ── 2. Groups ──
  const nodes = new Map<string, TopoNode>();
  const groupOf = new Map<string, string>(); // inst id → its group node id (for group instances)
  const addNode = (n: TopoNode) => nodes.set(n.id, n);
  const rgByName = new Map<string, string>();
  for (const i of insts.filter((x) => x.type === "azurerm_resource_group")) {
    addNode({ id: i.id, key: "", kind: "resourceGroup", label: nameOf(i), props: {}, armType: "Microsoft.Resources/resourceGroups", scope: "lab" });
    rgByName.set(nameOf(i).toLowerCase(), i.id);
    groupOf.set(i.id, i.id);
  }
  const primaryRgId = rgByName.get(primaryRg.toLowerCase()) ?? [...rgByName.values()].sort()[0] ?? null;
  const outsideRg = (name: string): string => {
    const id = `tf:rg/${name.toLowerCase()}`;
    if (!nodes.has(id)) addNode({ id, key: "", kind: "resourceGroup", label: name, props: {}, armType: "Microsoft.Resources/resourceGroups", scope: "outside" });
    rgByName.set(name.toLowerCase(), id);
    return id;
  };
  const rgIdOf = (i: TfInst): string | null => {
    const name = str(i.after.resource_group_name);
    if (name) return rgByName.get(name.toLowerCase()) ?? outsideRg(name);
    const viaRef = refs(i, ["resource_group_name"]).find((r) => r.type === "azurerm_resource_group");
    if (viaRef) return viaRef.id;
    return primaryRgId;
  };
  let laneGlobal: string | null = null;
  let laneTenant: string | null = null;
  const lane = (which: "global" | "tenant"): string => {
    const id = `lane/${which}`;
    if (!nodes.has(id)) addNode({ id, key: which === "global" ? SYNTHETIC_KEYS.globalLane : SYNTHETIC_KEYS.tenantLane, kind: "lane", label: which === "global" ? "Global" : "Tenant and Entra ID", props: {} });
    if (which === "global") laneGlobal = id;
    else laneTenant = id;
    return id;
  };

  const vnets = insts.filter((x) => groupKindOf(x) === "vnet");
  for (const v of vnets) {
    addNode({ id: v.id, key: "", kind: "vnet", label: labelOf(v), parent: rgIdOf(v) ?? undefined, props: {}, armType: "Microsoft.Network/virtualNetworks" });
    groupOf.set(v.id, v.id);
  }
  for (const h of insts.filter((x) => groupKindOf(x) === "virtualHub")) {
    addNode({ id: h.id, key: "", kind: "virtualHub", label: labelOf(h), parent: rgIdOf(h) ?? undefined, props: {}, armType: "Microsoft.Network/virtualHubs" });
    groupOf.set(h.id, h.id);
  }
  const vnetOfSubnet = (s: TfInst): TfInst | undefined => {
    const r = refs(s, ["virtual_network_name"]).find((x) => groupKindOf(x) === "vnet");
    if (r) return r;
    const name = str(s.after.virtual_network_name)?.toLowerCase();
    const rg = rgIdOf(s);
    return vnets.find((v) => nameOf(v).toLowerCase() === name && rgIdOf(v) === rg);
  };
  const subnetPath = new Map<string, [string, string]>(); // subnet node id → [vnet name, subnet name]
  for (const s of insts.filter((x) => x.type === "azurerm_subnet")) {
    const v = vnetOfSubnet(s);
    addNode({ id: s.id, key: "", kind: "subnet", label: labelOf(s), parent: v?.id ?? rgIdOf(s) ?? undefined, props: {}, armType: "Microsoft.Network/virtualNetworks/subnets" });
    groupOf.set(s.id, s.id);
    subnetPath.set(s.id, [v ? nameOf(v) : str(s.after.virtual_network_name) ?? "", nameOf(s)]);
  }
  // Inline subnet blocks (azurerm_virtual_network's `subnet`; a template VNet's properties.subnets).
  const inlineSubnets = new Map<string, Map<string, string>>(); // vnet id → subnet name (lower) → node id
  const inlineRefs: { subnet: string; ids: string[] }[] = []; // a template subnet's NSG, route table, NAT gateway ids
  for (const v of vnets) {
    const blocks = Array.isArray(v.after.subnet) ? v.after.subnet : Array.isArray(v.after.subnets) ? v.after.subnets : [];
    for (const b of blocks as Record<string, unknown>[]) {
      const name = str(b?.name);
      if (!name) continue;
      const id = `${v.id}/subnet/${name}`;
      const p = (b.properties ?? {}) as Record<string, unknown>;
      const prefix = (Array.isArray(b.address_prefixes) ? str(b.address_prefixes[0]) : undefined) ?? str(b.address_prefix) ?? str(p.addressPrefix) ?? (Array.isArray(p.addressPrefixes) ? str(p.addressPrefixes[0]) : undefined);
      addNode({ id, key: "", kind: "subnet", label: planLabel(name, input.number), parent: v.id, props: prefix ? { prefix } : {}, armType: "Microsoft.Network/virtualNetworks/subnets" });
      const ids = [p.networkSecurityGroup, p.routeTable, p.natGateway].map((x) => str((x as { id?: unknown } | undefined)?.id)).filter((x): x is string => !!x);
      if (ids.length) inlineRefs.push({ subnet: id, ids });
      subnetPath.set(id, [nameOf(v), name]);
      const m = inlineSubnets.get(v.id) ?? new Map<string, string>();
      m.set(name.toLowerCase(), id);
      inlineSubnets.set(v.id, m);
    }
  }

  // ── 3. Folding ──
  const isGroup = (i: TfInst) => groupKindOf(i) !== null;
  const owner = new Map<string, TfInst>();
  for (const i of insts) {
    if (isGroup(i)) continue;
    const rule = ruleOf(i);
    if (rule.fold) {
      for (const a of rule.fold) {
        const t = refs(i, [a])[0];
        if (t) {
          owner.set(i.id, t);
          break;
        }
      }
    } else if (rule.foldToReferrer) {
      const cands = referrers(i, rule.foldToReferrer.types, rule.foldToReferrer.attrs).sort((a, b) => cmp(a.address, b.address));
      if (cands[0]) owner.set(i.id, cands[0]);
    }
  }
  for (const i of insts) {
    const rule = ruleOf(i);
    for (const a of rule.pull ?? []) for (const t of refs(i, [a])) if (!owner.has(t.id) && !isGroup(t) && t !== i) owner.set(t.id, i);
  }
  // A template subnet's NSG, route table or NAT gateway: a chip on each subnet, folded into the first.
  const directOwner = new Map<string, string>();
  const inlineChips = new Map<string, string[]>();
  const CHIP_WORD: Record<string, string> = { networksecuritygroups: "NSG", routetables: "route table", natgateways: "NAT gateway" };
  for (const { subnet, ids } of inlineRefs) {
    for (const ref of ids) {
      const m = /\/providers\/([^/]+\/[^/]+)\/([^/]+)$/.exec(ref);
      const t = m ? insts.find((x) => x.armType?.toLowerCase() === m[1]!.toLowerCase() && x.name.toLowerCase() === m[2]!.toLowerCase()) : undefined;
      if (!t) continue;
      const word = CHIP_WORD[(t.armType ?? "").split("/")[1]?.toLowerCase() ?? ""] ?? "";
      inlineChips.set(subnet, [...(inlineChips.get(subnet) ?? []), `${word} ${labelOf(t)}`.trim()]);
      if (!owner.has(t.id) && !directOwner.has(t.id)) directOwner.set(t.id, subnet);
    }
  }
  const home = (i: TfInst, seen = new Set<string>()): string | null => {
    if (isGroup(i)) return groupOf.get(i.id) ?? i.id;
    const d = directOwner.get(i.id);
    if (d) return d;
    const o = owner.get(i.id);
    if (!o) return i.id;
    if (seen.has(i.id)) return null;
    seen.add(i.id);
    return home(o, seen);
  };

  // ── 4. Cards ──
  const kindOf = (i: TfInst): TopoKind => {
    if (i.armType) return kindOfArm(i.armType, str((i.after.__arm as { kind?: string } | undefined)?.kind));
    const r = ruleOf(i);
    if (r.kind) return r.kind;
    if (i.type === "azurerm_virtual_hub") return "routeServer";
    return kindOfTf(i.type);
  };
  const cards = insts.filter((i) => !isGroup(i) && !owner.has(i.id) && !directOwner.has(i.id));
  for (const i of cards) addNode({ id: i.id, key: "", kind: kindOf(i), label: labelOf(i), props: {}, armType: i.armType ?? ruleOf(i).arm ?? null });

  // Folded lists: every folded instance is listed on its home's card.
  for (const i of insts) {
    if (!owner.has(i.id) && !directOwner.has(i.id)) continue;
    const h = home(i);
    const n = h ? nodes.get(h) : undefined;
    if (!n) continue;
    (n.folded ??= []).push({ id: i.id, label: ruleOf(i).foldedLabel ?? labelOf(i), armType: i.armType ?? ruleOf(i).arm ?? null });
  }

  const subnetNodeOfInst = (t: TfInst): string | null => (t.type === "azurerm_subnet" ? t.id : null);
  const subnetsOf = (i: TfInst): string[] => {
    const out = new Set<string>();
    for (const t of refs(i)) {
      const s = subnetNodeOfInst(t);
      if (s) out.add(s);
    }
    // Through what folds into it (a VM's NICs).
    for (const f of insts) if (owner.get(f.id) === i) for (const t of refs(f)) {
      const s = subnetNodeOfInst(t);
      if (s) out.add(s);
    }
    // A template resource naming its subnet by ARM id (…/virtualNetworks/<v>/subnets/<s>).
    const arm = (i.after.__arm ?? null) as { subnetRefs?: [string, string][] } | null;
    for (const [v, s] of arm?.subnetRefs ?? []) {
      const vnet = vnets.find((x) => nameOf(x).toLowerCase() === v.toLowerCase());
      const id = vnet ? inlineSubnets.get(vnet.id)?.get(s.toLowerCase()) : undefined;
      if (id) out.add(id);
    }
    return [...out].sort();
  };
  const vnetOf = (i: TfInst): string | null => {
    const v = refs(i).find((t) => groupKindOf(t) === "vnet");
    if (v) return v.id;
    const s = subnetsOf(i)[0];
    return s ? (nodes.get(s)?.parent ?? null) : null;
  };

  for (const i of cards) {
    const n = nodes.get(i.id)!;
    const kind = n.kind;
    const place = KINDS[kind].placement;
    let parent: string | null = null;
    if (kind === "loadBalancer") {
      if (str(i.after.sku_tier)?.toLowerCase() === "global") parent = lane("global");
      else parent = subnetsOf(i)[0] ?? rgIdOf(i);
    } else if (kind === "policy") {
      parent = i.type === "azurerm_resource_group_policy_assignment" ? rgIdOf(i) : lane("tenant");
    } else if (kind === "wafPolicy" && i.type === "azurerm_cdn_frontdoor_firewall_policy") {
      parent = lane("global");
    } else if (place === "subnet" || kind === "generic") {
      parent = subnetsOf(i)[0] ?? (kind === "generic" ? null : vnetOf(i)) ?? rgIdOf(i);
    } else if (place === "vnet") parent = vnetOf(i) ?? rgIdOf(i);
    else if (place === "global") parent = lane("global");
    else if (place === "tenant") parent = lane("tenant");
    else if (place === "rg") parent = rgIdOf(i);
    if (parent) n.parent = parent;
  }

  // ── 5. Props, chips, edges ──
  const nodeByPrivateIp = (ip: string): string | null => {
    for (const n of [...nodes.values()].sort((a, b) => cmp(a.id, b.id))) if (n.props.privateIp === ip) return n.id;
    return null;
  };
  const helpers: PlannedHelpers = {
    refs,
    referrers,
    byType: (...types) => insts.filter((i) => types.includes(i.type)),
    home: (i) => home(i),
    label: labelOf,
    nodeByPrivateIp,
    subnetsOf,
  };
  // A rule may place its card in a group the kind's placement cannot find (a secured hub's firewall in the virtual hub).
  for (const i of cards) {
    const p = ruleOf(i).place?.(i, helpers);
    if (p && nodes.has(p) && isGroupKind(nodes.get(p)!.kind)) nodes.get(i.id)!.parent = p;
  }
  const raw = new Map<string, Record<string, unknown>>();
  for (const i of insts) {
    const n = nodes.get(i.id);
    if (!n) continue;
    const rule = ruleOf(i);
    const p = rule.props ? rule.props(i, helpers) : i.armType ? armProps(i) : {};
    raw.set(n.id, { ...(raw.get(n.id) ?? {}), ...p });
  }
  for (const n of nodes.values()) if (n.kind === "subnet" && !raw.has(n.id)) raw.set(n.id, { ...n.props, ...(inlineChips.has(n.id) ? { chips: inlineChips.get(n.id) } : {}) });
  // Template VNets' and subnets' props.
  for (const v of vnets) if (v.armType) raw.set(v.id, { addressSpace: ((v.after.addressSpace as { addressPrefixes?: string[] } | undefined)?.addressPrefixes ?? []).filter((x) => typeof x === "string") });
  // RG role chip and a resource group's tags.
  for (const n of nodes.values()) {
    if (n.kind !== "resourceGroup") continue;
    const r = raw.get(n.id) ?? {};
    const lower = n.label.toLowerCase();
    const role = lower.startsWith(`${primaryRg}-`) ? lower.slice(primaryRg.length + 1) : null;
    if (role) r.chips = [...((r.chips as string[]) ?? []), role];
    if (n.scope === "outside") r.chips = [...((r.chips as string[]) ?? []), "outside the lab"];
    raw.set(n.id, r);
  }
  // NAT gateway public IPs and similar: the first folded public IP's address is not known at plan, so nothing to show.
  for (const i of insts) {
    const rule = ruleOf(i);
    if (!rule.chips) continue;
    for (const c of rule.chips(i, helpers)) {
      const targets = c.on === "home" ? [home(i)] : refs(i, [c.on]).map((t) => home(t));
      for (const t of targets) {
        if (!t) continue;
        const r = raw.get(t) ?? {};
        const chips = (r.chips as string[] | undefined) ?? [];
        if (!chips.includes(c.chip)) chips.push(c.chip);
        r.chips = chips;
        raw.set(t, r);
      }
    }
  }
  // Peer target: the VNet the peer_vnet_id output names.
  for (const cfg of input.refs["output.peer_vnet_id"]?.value ?? []) {
    for (const t of byConfig.get(cfg) ?? []) if (groupKindOf(t) === "vnet") raw.set(t.id, { ...(raw.get(t.id) ?? {}), peerTarget: true });
  }

  // Scrub, scope.
  let withheld = 0;
  const outsideIds = new Set([...nodes.values()].filter((n) => n.kind === "resourceGroup" && n.scope === "outside").map((n) => n.id));
  const rgOfNode = (n: TopoNode): TopoNode | undefined => {
    let cur: TopoNode | undefined = n;
    for (let d = 0; cur && d < 10; d++) {
      if (cur.kind === "resourceGroup") return cur;
      cur = cur.parent ? nodes.get(cur.parent) : undefined;
    }
    return undefined;
  };
  for (const n of nodes.values()) {
    const r = { ...(raw.get(n.id) ?? {}) };
    if (Array.isArray(r.chips)) r.chips = (r.chips as string[]).length ? [...(r.chips as string[])] : undefined;
    const s = scrubProps(r);
    withheld += s.withheld;
    n.props = s.props;
    if (n.kind !== "lane") {
      const rg = rgOfNode(n);
      if (rg && outsideIds.has(rg.id)) n.scope = "outside";
      else if (n.kind !== "resourceGroup" && rg) n.scope = "lab";
    }
  }

  // Edges.
  const edges = new Map<string, TopoEdge>();
  const endOf = (x: TfInst | string): string | null => (typeof x === "string" ? (x.startsWith("node:") ? x.slice(5) : x) : home(x));
  for (const i of insts) {
    const rule = ruleOf(i);
    if (!rule.edges) continue;
    for (const spec of rule.edges(i, helpers) as EdgeSpec[]) {
      let from = endOf(spec.from);
      let to = endOf(spec.to);
      if (!from || !to || from === to || !nodes.has(from) || !nodes.has(to)) continue;
      if (spec.undirected && to < from) [from, to] = [to, from];
      const via = (spec.via ?? i).id;
      const id = `${spec.kind}:${from}>${to}:${spec.label ?? ""}`;
      if (edges.has(id)) continue;
      edges.set(id, { id, from, to, kind: spec.kind, ...(spec.label ? { label: spec.label } : {}), via });
    }
  }

  // ── Keys and labels ──
  const keyed: { id: string; key: string; group: string | null }[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "lane") {
      keyed.push({ id: n.id, key: n.key, group: null });
      continue;
    }
    const i = byId.get(n.id);
    let key: string;
    if (n.kind === "subnet") key = nodeKey("Microsoft.Network/virtualNetworks/subnets", subnetPath.get(n.id) ?? [n.label], nameCtx);
    else if (n.kind === "resourceGroup") key = nodeKey("Microsoft.Resources/resourceGroups", [n.label], nameCtx);
    else if (i) {
      const arm = i.armType ?? ruleOf(i).arm ?? (KINDS[n.kind].armTypes.length === 1 ? KINDS[n.kind].armTypes[0] : undefined);
      const path = ruleOf(i).namePath?.(i, helpers) ?? [nameOf(i)];
      key = arm ? nodeKey(arm, path, nameCtx) : `terraform/${i.type}/${path.map((p) => p.toLowerCase()).join("/")}`;
      if (!n.armType && arm) n.armType = arm;
    } else key = `tf/${n.id}`;
    keyed.push({ id: n.id, key, group: rgOfNode(n)?.label ?? null });
  }
  const keys = disambiguate(keyed, primaryRg);
  for (const n of nodes.values()) n.key = keys[n.id] ?? n.key;

  // Notes.
  const generic = [...nodes.values()].filter((n) => n.kind === "generic").length;
  if (generic) notes.push(`${generic} resource${generic === 1 ? "" : "s"} of a type the diagram draws plainly`);
  if (withheld) notes.push(withheldNote(withheld));
  void laneGlobal;
  void laneTenant;

  const g: TopologyGraph = {
    schema: TOPOLOGY_SCHEMA,
    labId: input.labId,
    version: input.version,
    source: "planned",
    at: null,
    nodes: [...nodes.values()].map((n) => {
      const out: TopoNode = { id: n.id, key: n.key, kind: n.kind, label: n.label, props: n.props };
      if (n.parent) out.parent = n.parent;
      if (n.armType !== undefined) out.armType = n.armType;
      if (n.scope) out.scope = n.scope;
      if (n.folded?.length) out.folded = n.folded;
      return out;
    }),
    edges: [...edges.values()],
    ...(notes.length ? { notes } : {}),
  };
  return sortGraph(g);
}

/** Props of a template-expanded resource, by ARM type (the few the core reads). */
function armProps(i: TfInst): Record<string, unknown> {
  const t = (i.armType ?? "").toLowerCase();
  const a = (i.after.__arm ?? {}) as { sku?: { name?: string }; kind?: string; properties?: Record<string, unknown> };
  const p = a.properties ?? {};
  if (t === "microsoft.storage/storageaccounts") return { accountKind: a.kind, sku: a.sku?.name, accessTier: str(p.accessTier), publicAccess: typeof p.allowBlobPublicAccess === "boolean" ? p.allowBlobPublicAccess : undefined };
  if (t === "microsoft.network/networksecuritygroups") return { counts: [`rules: ${Array.isArray(p.securityRules) ? p.securityRules.length : 0}`] };
  return {};
}
