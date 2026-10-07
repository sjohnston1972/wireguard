// shared/topology/rules/planned.ts
//
// Plain English: what each Terraform resource type becomes on a planned
// diagram (lab topology spec §4.4-§4.6): a card of some kind, a group
// (resource group, VNet, subnet, virtual hub), something folded into another
// card (a VM's NIC, an LB's rules), or the maker of an edge (a peering, a
// route, an LB rule). planned.ts runs these rules; T3 extends them per lab
// family. A type with no rule is a card of kindOfTf(type), `generic` when the
// registry does not know it: never dropped.
//
// Attribute names are Terraform's (azurerm 4.x). `refs` are the HCL
// references of a top-level attribute (ruling 1); values come from the mock
// plan, where computed ids are unknown.

import type { TopoKind } from "../model";
import { tagProps } from "../props";

/** A planned resource instance as the rules see it. */
export interface TfInst {
  /** "tf:<address>". */
  id: string;
  address: string;
  /** "type.name": what HCL references name. */
  config: string;
  type: string;
  name: string;
  index: string | number | null;
  after: Record<string, unknown>;
  /** ARM type for resources expanded from a template deployment (armTemplate.ts). */
  armType?: string;
}

/** An edge a rule asks for: from and to are instances or node ids ("node:<id>"). */
export interface EdgeSpec {
  from: TfInst | string;
  to: TfInst | string;
  kind: "traffic" | "dependency";
  label?: string;
  /** The resource making it; defaults to the rule's own instance. */
  via?: TfInst;
  /** One edge per unordered pair (peerings). */
  undirected?: boolean;
}

/** What planned.ts offers the rules. */
export interface PlannedHelpers {
  /** The instances an attribute (or any attribute) of `inst` references. */
  refs(inst: TfInst, attrs?: string[]): TfInst[];
  /** The instances whose `attrs` (or any attribute) reference `inst`, of the given types (or any). */
  referrers(inst: TfInst, types?: string[], attrs?: string[]): TfInst[];
  byType(...types: string[]): TfInst[];
  /** The node id an instance ends up drawn as (itself, or the card it folds into). */
  home(inst: TfInst): string | null;
  /** The name as shown (mock prefix as "l06…"). */
  label(inst: TfInst): string;
  /** The node id of the asset whose private IP this is, if any. */
  nodeByPrivateIp(ip: string): string | null;
  /** The subnet node ids an instance's references reach (directly, or through a NIC). */
  subnetsOf(inst: TfInst): string[];
}

export interface TfRule {
  /** ARM type, for keys (and the card's type line). */
  arm?: string;
  /** The card's kind (default kindOfTf). */
  kind?: TopoKind;
  /** Not an Azure resource: never drawn. */
  ignore?: true;
  /** Fold into the first instance that one of these attributes references. */
  fold?: string[];
  /** Fold into the first instance (by address) of these types that references this one. */
  foldToReferrer?: { types?: string[]; attrs?: string[] };
  /** Pull what these attributes reference into this instance's home too (an association's NSG, ASG, route table). */
  pull?: string[];
  /** Chips added to a node: `on` is "home" (this instance's home) or an attribute whose referenced instances' homes get it. */
  chips?: (inst: TfInst, h: PlannedHelpers) => { on: string; chip: string }[];
  /** Props for this instance's own node. */
  props?: (inst: TfInst, h: PlannedHelpers) => Record<string, unknown>;
  /** Edges this instance makes. */
  edges?: (inst: TfInst, h: PlannedHelpers) => EdgeSpec[];
  /** The name path for the key (default [name]). */
  namePath?: (inst: TfInst, h: PlannedHelpers) => string[];
  /** What a folded entry says instead of the name (a Key Vault secret: "secret"; ruling 22, never the name). */
  foldedLabel?: string;
  /** Its folded entry's id is opaque and counted ("tf:azurerm_key_vault_secret#1"), never the Terraform address (a block name like app_db_password). */
  opaqueId?: boolean;
  /** A group node id to place this card in, when the kind's placement cannot find it (a secured hub's firewall). */
  place?: (inst: TfInst, h: PlannedHelpers) => string | null;
}

/** An env value's scheme and host: "http://ca-app/x" → { scheme: "http", host: "ca-app" }; "tcp:srv,1433" → srv. */
export function urlHost(v: string): { scheme?: string; host: string } | null {
  const m = /^(?:([a-z][a-z0-9+.-]*):(?:\/\/)?)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.?(?=$|[:,/?#])/i.exec(v.trim());
  return m ? { scheme: m[1]?.toLowerCase(), host: m[2]!.toLowerCase() } : null;
}
const lower = (s: string | undefined) => (s ?? "").toLowerCase();

/** The label of a call from one container app to another: the URL's scheme, HTTPS unless it says http. */
export const appCallLabel = (scheme: string | undefined) => (scheme === "http" ? "HTTP" : "HTTPS");

/**
 * A container app's calls to the next tier (lab 28), from its containers' env values: a reference in its template to
 * another container app (its ingress FQDN) or a SQL server (its FQDN), or a known value naming another app of the same
 * environment ("http://ca-app"). Traffic edges, "HTTP"/"HTTPS" by the URL's scheme, "SQL 1433" to a server.
 */
function tierEdges(i: TfInst, h: PlannedHelpers): EdgeSpec[] {
  const out = new Map<string, EdgeSpec>();
  const add = (to: TfInst, label: string) => {
    if (to !== i && !out.has(to.id)) out.set(to.id, { from: i, to, kind: "traffic", label });
  };
  const env = (x: TfInst) => h.refs(x, ["container_app_environment_id"])[0];
  const apps = h.byType("azurerm_container_app").filter((a) => a !== i);
  // Known values first: they say the scheme.
  for (const c of list(first(i.after.template).container)) {
    for (const e of list((c as Record<string, unknown> | null)?.env)) {
      const v = str((e as Record<string, unknown> | null)?.value);
      const u = v ? urlHost(v) : null;
      if (!u) continue;
      const app = apps.find((a) => (lower(str(a.after.name)) === u.host && env(a) === env(i)) || lower(str(first(a.after.ingress).fqdn)) === u.host);
      if (app) add(app, appCallLabel(u.scheme));
      const sql = h.byType("azurerm_mssql_server").find((s) => lower(str(s.after.fully_qualified_domain_name)) === u.host);
      if (sql) add(sql, "SQL 1433");
    }
  }
  for (const r of h.refs(i, ["template"])) {
    if (r.type === "azurerm_container_app") add(r, "HTTPS");
    else if (r.type === "azurerm_mssql_server") add(r, "SQL 1433");
  }
  return [...out.values()];
}

/** Types that are never Azure resources (spec §4.4): random_*, time_*, terraform_data, null_resource. */
export const TF_IGNORED_PREFIXES = ["random_", "time_", "terraform_data", "null_resource"];

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const first = (v: unknown): Record<string, unknown> => (list(v)[0] && typeof list(v)[0] === "object" ? (list(v)[0] as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === "string");

/** "Tcp" → "TCP". */
const proto = (p: unknown) => (str(p) ?? "").toUpperCase() || "ANY";

const VM_TYPES = ["azurerm_linux_virtual_machine", "azurerm_windows_virtual_machine", "azurerm_virtual_machine"];

/** A static private IP from a NIC's (or an IP configuration list's) first configuration. */
export function staticIp(ipConfigs: unknown): string | undefined {
  const c = first(ipConfigs);
  return str(c.private_ip_address_allocation)?.toLowerCase() === "static" ? str(c.private_ip_address) : undefined;
}

const vmProps = (os: string) => (inst: TfInst, h: PlannedHelpers) => {
  const nics = h.refs(inst, ["network_interface_ids"]);
  const nic = nics[0];
  return {
    size: str(inst.after.size) ?? str(inst.after.vm_size),
    os,
    zones: str(inst.after.zone) ? [str(inst.after.zone)!] : undefined,
    privateIp: nic ? staticIp(nic.after.ip_configuration) : undefined,
  };
};

/** The name an instance is shown by in a key path (its planned `name`, else its address name). */
const nameOf = (i: TfInst | undefined): string => (i ? (str(i.after.name) ?? (i.index !== null ? `${i.name}[${i.index}]` : i.name)) : "");

/** A child resource's key path: its parent's name (the instance `attr` references), then its own (ruling 6). */
const childPath =
  (...attrs: string[]) =>
  (i: TfInst, h: PlannedHelpers): string[] => {
    for (const a of attrs) {
      const p = h.refs(i, [a])[0];
      if (p) return [nameOf(p), nameOf(i)];
    }
    // The parent named by value (a `*_name` attribute) when it is not a reference.
    for (const a of attrs) if (str(i.after[a])) return [str(i.after[a])!, nameOf(i)];
    return [nameOf(i)];
  };

/** A scale set's props: size, instances and the autoscale range of the setting that targets it. */
const vmssProps = (os: string) => (inst: TfInst, h: PlannedHelpers) => {
  const auto = h.referrers(inst, ["azurerm_monitor_autoscale_setting"], ["target_resource_id"])[0];
  const cap = auto ? first(first(auto.after.profile).capacity) : {};
  return {
    size: str(inst.after.sku) ?? str(inst.after.sku_name),
    os: os || undefined,
    instances: num(inst.after.instances),
    autoscale: num(cap.minimum) !== undefined ? `${num(cap.minimum)}-${num(cap.maximum) ?? "?"}` : undefined,
    zones: strings(inst.after.zones).length ? strings(inst.after.zones) : undefined,
  };
};

/** A policy's effect from its parameters JSON: an assignment's value, or (for a definition) the default. */
function policyEffect(parameters: unknown, isDefinition = false): string | undefined {
  const s = str(parameters);
  if (!s) return undefined;
  try {
    const p = JSON.parse(s) as Record<string, { value?: unknown; defaultValue?: unknown }>;
    const e = p.effect ?? p.Effect;
    const v = isDefinition ? e?.defaultValue : e?.value;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A policy assignment: in its RG (RG scope) or the Tenant lane; edges to its definition, its scope (a management group) and what its parameters name. */
function policyAssignment(scopeAttr?: string): TfRule {
  return {
    arm: "Microsoft.Authorization/policyAssignments",
    props: (i) => ({ effect: policyEffect(i.after.parameters), enforcement: i.after.enforce === false ? "DoNotEnforce" : undefined }),
    edges: (i, h) => [
      ...h.refs(i, ["policy_definition_id"]).map((d) => ({ from: i, to: d, kind: "dependency" as const, label: "assigns" })),
      ...(scopeAttr ? h.refs(i, [scopeAttr]).filter((s) => s.type !== "azurerm_resource_group").map((s) => ({ from: i, to: s, kind: "dependency" as const, label: "scope" })) : []),
      ...h.refs(i, ["parameters"]).map((p) => ({ from: i, to: p, kind: "dependency" as const, label: "parameter" })),
    ],
  };
}
const policySetEdges = (i: TfInst, h: PlannedHelpers): EdgeSpec[] => h.refs(i, ["policy_definition_reference"]).map((d) => ({ from: i, to: d, kind: "dependency" as const, label: "includes" }));

/** An alert: → each scope it watches ("alert"), → each action group it notifies. */
const alertEdges = (i: TfInst, h: PlannedHelpers): EdgeSpec[] => [
  ...h.refs(i, ["scopes"]).map((s) => ({ from: i, to: s, kind: "dependency" as const, label: "alert" })),
  ...h.refs(i, ["action"]).filter((a) => a.type === "azurerm_monitor_action_group").map((a) => ({ from: i, to: a, kind: "dependency" as const, label: "notifies" })),
];

/** Every route of a route table instance: inline `route` blocks, and azurerm_route resources naming it. */
function routesOf(rt: TfInst, h: PlannedHelpers): { via: TfInst; prefix?: string; hopType?: string; hopIp?: string; hopRefs: TfInst[] }[] {
  const out: { via: TfInst; prefix?: string; hopType?: string; hopIp?: string; hopRefs: TfInst[] }[] = [];
  const inline = list(rt.after.route);
  // An inline route's next hop by reference (a firewall's private IP, unknown at plan): the table's `route` refs, when it has one route.
  const inlineRefs = inline.length === 1 ? h.refs(rt, ["route"]) : [];
  for (const r of inline) {
    const o = (r ?? {}) as Record<string, unknown>;
    out.push({ via: rt, prefix: str(o.address_prefix), hopType: str(o.next_hop_type), hopIp: str(o.next_hop_in_ip_address), hopRefs: inlineRefs });
  }
  for (const r of h.referrers(rt, ["azurerm_route"], ["route_table_name", "route_table_id"]))
    out.push({ via: r, prefix: str(r.after.address_prefix), hopType: str(r.after.next_hop_type), hopIp: str(r.after.next_hop_in_ip_address), hopRefs: h.refs(r, ["next_hop_in_ip_address"]) });
  return out;
}

/**
 * The next-hop edges of a route table: from each subnet it serves (or the table's own card) to the appliance holding
 * the hop IP (a VM's static IP), or, when the IP is only known after apply, the appliance the hop references (a
 * firewall's private IP).
 */
function nextHopEdges(rt: TfInst, h: PlannedHelpers): EdgeSpec[] {
  const assoc = h.referrers(rt, ["azurerm_subnet_route_table_association"], ["route_table_id"]);
  const subnets = assoc.flatMap((a) => h.refs(a, ["subnet_id"]));
  const froms: (TfInst | string)[] = subnets.length ? subnets : [rt];
  const out: EdgeSpec[] = [];
  for (const r of routesOf(rt, h)) {
    if (r.hopType?.toLowerCase() !== "virtualappliance") continue;
    const to: TfInst | string | null = (r.hopIp ? h.nodeByPrivateIp(r.hopIp) : null) ?? r.hopRefs.find((x) => !x.type.startsWith("azurerm_subnet") && x.type !== "azurerm_route_table") ?? null;
    if (!to) continue;
    for (const from of froms) out.push({ from, to, kind: "traffic", label: r.prefix ?? "route", via: r.via });
  }
  return out;
}

/** DNS record types: each folds into its zone (keyed under it), never a card; zones count them. */
const DNS_RECORD_TYPES = ["a", "aaaa", "caa", "cname", "mx", "ns", "ptr", "srv", "txt"];
const recordRules = (): Record<string, TfRule> => {
  const out: Record<string, TfRule> = {};
  for (const t of DNS_RECORD_TYPES) {
    const T = t.toUpperCase();
    out[`azurerm_dns_${t}_record`] = { arm: `Microsoft.Network/dnszones/${T}`, fold: ["zone_name"], namePath: childPath("zone_name") };
    out[`azurerm_private_dns_${t}_record`] = {
      arm: `Microsoft.Network/privateDnsZones/${T}`,
      fold: ["zone_name"],
      namePath: childPath("zone_name"),
      // A private record naming a resource's address (a NIC, an LB, an endpoint): a dependency edge from the zone.
      edges: (i, h) =>
        h.refs(i, ["zone_name"]).flatMap((z) => [
          ...h
            .refs(i, ["records", "record"])
            .filter((x) => x !== z)
            .map((x) => ({ from: z, to: x as TfInst | string, kind: "dependency" as const, label: `${T} ${nameOf(i)}` })),
          // An address written out (a gateway's static frontend): whatever holds it.
          ...strings(i.after.records)
            .map((ip) => h.nodeByPrivateIp(ip))
            .filter((x): x is string => !!x)
            .map((n) => ({ from: z, to: `node:${n}`, kind: "dependency" as const, label: `${T} ${nameOf(i)}` })),
        ]),
    };
  }
  return out;
};
const recordCount = (zone: TfInst, h: PlannedHelpers, prefix: string): string[] | undefined => {
  const n = h.referrers(zone, DNS_RECORD_TYPES.map((t) => `${prefix}${t}_record`), ["zone_name"]).length;
  return n ? [`records: ${n}`] : undefined;
};

/**
 * The homes of an LB backend pool's members: NICs associated with it, anything (a VMSS) that references it, and a
 * Global-tier pool's regional LB frontends (azurerm_lb_backend_address_pool_address's ip configuration).
 */
function poolBackends(pool: TfInst, h: PlannedHelpers): string[] {
  const out = new Set<string>();
  for (const a of h.referrers(pool, ["azurerm_network_interface_backend_address_pool_association"], ["backend_address_pool_id"])) {
    for (const nic of h.refs(a, ["network_interface_id"])) {
      const home = h.home(nic);
      if (home) out.add(home);
    }
  }
  for (const a of h.referrers(pool, ["azurerm_lb_backend_address_pool_address"], ["backend_address_pool_id"])) {
    for (const t of h.refs(a, ["backend_address_ip_configuration_id"])) {
      const home = h.home(t);
      if (home) out.add(home);
    }
  }
  for (const r of h.referrers(pool)) {
    if (r.type.startsWith("azurerm_lb") || r.type === "azurerm_network_interface_backend_address_pool_association") continue;
    const home = h.home(r);
    if (home) out.add(home);
  }
  return [...out].sort();
}

/** An LB rule's label: "TCP 80→80"; HA ports (protocol All, port 0) say so. */
const lbRuleLabel = (protocol: unknown, fe: unknown, be: unknown): string =>
  str(protocol)?.toLowerCase() === "all" && (num(fe) ?? 0) === 0 && (num(be) ?? 0) === 0 ? "HA ports" : `${proto(protocol)} ${num(fe) ?? "?"}→${num(be) ?? "?"}`;

/** An App Gateway's request routing as labels per backend pool name: "HTTPS 443→80" (listener protocol and port → backend port). */
function appGwLabels(after: Record<string, unknown>): Map<string, string> {
  const byName = (k: string) => new Map(list(after[k]).map((x) => [str((x as Record<string, unknown>)?.name) ?? "", (x ?? {}) as Record<string, unknown>]));
  const listeners = byName("http_listener");
  const ports = byName("frontend_port");
  const settings = byName("backend_http_settings");
  const out = new Map<string, string>();
  const rules = list(after.request_routing_rule).map((x) => (x ?? {}) as Record<string, unknown>).sort((a, b) => (num(a.priority) ?? 0) - (num(b.priority) ?? 0));
  for (const r of rules) {
    const pool = str(r.backend_address_pool_name);
    if (!pool || out.has(pool)) continue;
    const l = listeners.get(str(r.http_listener_name) ?? "") ?? {};
    const fp = num(ports.get(str(l.frontend_port_name) ?? "")?.port);
    const bp = num(settings.get(str(r.backend_http_settings_name) ?? "")?.port);
    out.set(pool, `${proto(l.protocol)} ${fp ?? "?"}→${bp ?? "?"}`);
  }
  return out;
}

/** Front Door: the profile an origin (through its group) or a child belongs to. */
const fdProfileOf = (i: TfInst, h: PlannedHelpers): TfInst | undefined => {
  const direct = h.refs(i, ["cdn_frontdoor_profile_id"])[0];
  if (direct) return direct;
  const group = h.refs(i, ["cdn_frontdoor_origin_group_id"])[0];
  return group ? h.refs(group, ["cdn_frontdoor_profile_id"])[0] : undefined;
};
const fdFold: TfRule["fold"] = ["cdn_frontdoor_profile_id", "cdn_frontdoor_origin_group_id", "cdn_frontdoor_rule_set_id", "cdn_frontdoor_endpoint_id"];

/** The resource a user-assigned identity block names, as a dependency edge resource → identity. */
const identityEdges = (i: TfInst, h: PlannedHelpers): EdgeSpec[] => h.refs(i, ["identity"]).filter((x) => x.type === "azurerm_user_assigned_identity").map((x) => ({ from: i, to: x, kind: "dependency" as const, label: "identity" }));

/** A Traffic Manager endpoint's label: its priority or weight under the profile's routing method. */
const tmLabel = (ep: TfInst, profile: TfInst | undefined): string => {
  const method = str(profile?.after.traffic_routing_method)?.toLowerCase();
  if (method === "priority" && num(ep.after.priority) !== undefined) return `priority ${num(ep.after.priority)}`;
  if (method === "weighted" && num(ep.after.weight) !== undefined) return `weight ${num(ep.after.weight)}`;
  return str(profile?.after.traffic_routing_method) ?? "endpoint";
};
const tmEndpoint = (arm: string, targetAttrs: string[]): TfRule => ({
  arm,
  fold: ["profile_id"],
  namePath: childPath("profile_id"),
  edges: (i, h) => {
    const profile = h.refs(i, ["profile_id"])[0];
    if (!profile) return [];
    return h.refs(i, targetAttrs).map((t) => ({ from: profile, to: t, kind: "traffic" as const, label: tmLabel(i, profile) }));
  },
});

const lbChildFold: TfRule = { fold: ["loadbalancer_id"], arm: undefined };

/** What can own a public IP (it folds into the first, by address). */
const PIP_OWNERS = [
  "azurerm_network_interface",
  "azurerm_lb",
  "azurerm_application_gateway",
  "azurerm_virtual_network_gateway",
  "azurerm_bastion_host",
  "azurerm_firewall",
  "azurerm_route_server",
  "azurerm_nat_gateway",
  "azurerm_nat_gateway_public_ip_association",
  "azurerm_virtual_hub_ip",
  "azurerm_express_route_gateway",
  "azurerm_vpn_gateway",
];

/** A Cosmos DB account's API, from its kind and capabilities (the same words live, rules/live.ts). */
export function cosmosApi(kind: string | undefined, capabilities: string[]): string | undefined {
  const caps = capabilities.map((c) => c.toLowerCase());
  if ((kind ?? "").toLowerCase() === "mongodb") return "MongoDB";
  if (caps.includes("enablecassandra")) return "Cassandra";
  if (caps.includes("enablegremlin")) return "Gremlin";
  if (caps.includes("enabletable")) return "Table";
  return kind ? "NoSQL" : undefined;
}

/** An AKS cluster's pod networking in words, from its network plugin and mode (the same words live, rules/live.ts). */
export function aksNetworkWord(plugin: string | undefined, mode: string | undefined): string | undefined {
  const p = (plugin ?? "").toLowerCase();
  if (p === "azure") return (mode ?? "").toLowerCase() === "overlay" ? "Azure CNI Overlay" : "Azure CNI";
  if (p === "kubenet") return "kubenet";
  if (p === "none") return "bring-your-own CNI";
  return undefined;
}

/** A VPN connection's label: "IPsec", "IPsec, BGP", "VNet-to-VNet". */
const connectionLabel = (i: TfInst): string => {
  const t = str(i.after.type)?.toLowerCase();
  const base = t === "vnet2vnet" ? "VNet-to-VNet" : t === "expressroute" ? "ExpressRoute" : "IPsec";
  return i.after.bgp_enabled === true || i.after.enable_bgp === true ? `${base}, BGP` : base;
};

/** AVNM children fold into the manager (through their group, collection or configuration). */
const avnmFold = ["network_manager_id", "network_group_id", "security_admin_configuration_id", "admin_rule_collection_id", "connectivity_configuration_id"];
const avnmManagerOf = (i: TfInst, h: PlannedHelpers): TfInst | undefined => {
  for (let cur: TfInst | undefined = i, d = 0; cur && d < 5; d++) {
    if (cur.type === "azurerm_network_manager") return cur;
    cur = h.refs(cur, avnmFold)[0];
  }
  return undefined;
};
const avnmMembers = (group: TfInst, h: PlannedHelpers): TfInst[] => h.referrers(group, ["azurerm_network_manager_static_member"], ["network_group_id"]).flatMap((m) => h.refs(m, ["target_virtual_network_id"]));

export const TF_RULES: Record<string, TfRule> = {
  // ── Groups ──
  azurerm_resource_group: {
    arm: "Microsoft.Resources/resourceGroups",
    props: (i) => ({ region: str(i.after.location), tags: tagProps(i.after.tags as Record<string, unknown>) }),
  },
  azurerm_virtual_network: {
    arm: "Microsoft.Network/virtualNetworks",
    props: (i) => ({ addressSpace: strings(i.after.address_space), dnsServers: strings(i.after.dns_servers).length ? strings(i.after.dns_servers) : undefined }),
  },
  azurerm_subnet: {
    arm: "Microsoft.Network/virtualNetworks/subnets",
    props: (i) => {
      const chips: string[] = [];
      const d = first(first(i.after.delegation).service_delegation);
      if (str(d.name)) chips.push(`delegation ${str(d.name)}`);
      const se = strings(i.after.service_endpoints);
      if (se.length) chips.push(`service endpoints ${se.join(", ")}`);
      if (i.after.default_outbound_access_enabled === false) chips.push("no default outbound");
      return { prefix: strings(i.after.address_prefixes)[0], chips };
    },
  },
  azurerm_virtual_hub: {
    arm: "Microsoft.Network/virtualHubs",
    props: (i, h) => {
      // Routing intent (folded into the hub): its destinations, as the hub's routing.
      const ri = h.referrers(i, ["azurerm_virtual_hub_routing_intent"], ["virtual_hub_id"])[0];
      const dest = ri ? list(ri.after.routing_policy).flatMap((p) => strings((p as Record<string, unknown>)?.destinations)) : [];
      return { prefix: str(i.after.address_prefix), sku: str(i.after.sku), routing: dest.length ? `routing intent: ${dest.join(", ")}` : undefined };
    },
    edges: (i, h) => h.refs(i, ["virtual_wan_id"]).map((w) => ({ from: w, to: i, kind: "dependency" as const, label: "virtual hub" })),
  },

  // ── Compute ──
  azurerm_linux_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps("Linux"), edges: (i, h) => identityEdges(i, h) },
  azurerm_windows_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps("Windows"), edges: (i, h) => identityEdges(i, h) },
  azurerm_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps(""), edges: (i, h) => identityEdges(i, h) },
  azurerm_network_interface: { arm: "Microsoft.Network/networkInterfaces", foldToReferrer: { types: VM_TYPES, attrs: ["network_interface_ids"] } },
  azurerm_managed_disk: { arm: "Microsoft.Compute/disks", foldToReferrer: { types: ["azurerm_virtual_machine_data_disk_attachment"] } },
  azurerm_virtual_machine_data_disk_attachment: { fold: ["virtual_machine_id"], pull: ["managed_disk_id"] },
  azurerm_virtual_machine_extension: { arm: "Microsoft.Compute/virtualMachines/extensions", fold: ["virtual_machine_id"] },
  azurerm_network_interface_security_group_association: {
    fold: ["network_interface_id"],
    pull: ["network_security_group_id"],
    chips: (i, h) => h.refs(i, ["network_security_group_id"]).map((n) => ({ on: "home", chip: `NSG ${h.label(n)}` })),
  },
  azurerm_network_interface_application_security_group_association: {
    fold: ["network_interface_id"],
    pull: ["application_security_group_id"],
    chips: (i, h) => h.refs(i, ["application_security_group_id"]).map((n) => ({ on: "home", chip: `ASG ${h.label(n)}` })),
  },
  azurerm_application_security_group: { arm: "Microsoft.Network/applicationSecurityGroups" },

  // ── Scale sets (T3.5): one card with its instances and autoscale range (ruling 19); the autoscale setting folds in ──
  azurerm_linux_virtual_machine_scale_set: { arm: "Microsoft.Compute/virtualMachineScaleSets", props: vmssProps("Linux"), edges: (i, h) => identityEdges(i, h) },
  azurerm_windows_virtual_machine_scale_set: { arm: "Microsoft.Compute/virtualMachineScaleSets", props: vmssProps("Windows"), edges: (i, h) => identityEdges(i, h) },
  azurerm_orchestrated_virtual_machine_scale_set: { arm: "Microsoft.Compute/virtualMachineScaleSets", props: vmssProps(""), edges: (i, h) => identityEdges(i, h) },
  azurerm_monitor_autoscale_setting: { arm: "Microsoft.Insights/autoscaleSettings", fold: ["target_resource_id"] },

  // ── Containers (T3.5) ──
  azurerm_container_group: {
    arm: "Microsoft.ContainerInstance/containerGroups",
    props: (i) => {
      const cs = list(i.after.container).map((c) => (c ?? {}) as Record<string, unknown>);
      const sum = (k: string) => Math.round(cs.reduce((a, c) => a + (num(c[k]) ?? 0), 0) * 100) / 100;
      const type = str(i.after.ip_address_type)?.toLowerCase();
      return { cpu: cs.length ? sum("cpu") : undefined, memoryGb: cs.length ? sum("memory") : undefined, chips: type ? [type === "private" ? "private IP" : type === "public" ? "public IP" : "no IP"] : undefined };
    },
    edges: (i, h) => [...identityEdges(i, h), ...h.refs(i, ["image_registry_credential"]).filter((r) => r.type === "azurerm_container_registry").map((r) => ({ from: i, to: r, kind: "dependency" as const, label: "pulls images" }))],
  },
  azurerm_container_app_environment: {
    arm: "Microsoft.App/managedEnvironments",
    // The group Azure makes for an environment in a subnet, named by the lab (lab 28: rg-lab-<id>-infra), as a chip.
    props: (i) => {
      const infra = str(i.after.infrastructure_resource_group_name);
      return { sku: str(first(i.after.workload_profile).workload_profile_type) ?? "Consumption", chips: infra ? [`infra group ${infra}`] : undefined };
    },
    edges: (i, h) => h.refs(i, ["log_analytics_workspace_id"]).map((w) => ({ from: i, to: w, kind: "dependency" as const, label: "logs" })),
  },
  azurerm_container_app: {
    arm: "Microsoft.App/containerApps",
    props: (i) => {
      const ing = first(i.after.ingress);
      return { ingress: Object.keys(ing).length ? (ing.external_enabled === true ? "external" : "internal") : undefined, targetPort: num(ing.target_port) };
    },
    edges: (i, h) => [
      ...h.refs(i, ["container_app_environment_id"]).map((e) => ({ from: i, to: e, kind: "dependency" as const, label: "environment" })),
      ...h.refs(i, ["registry"]).filter((r) => r.type === "azurerm_container_registry").map((r) => ({ from: i, to: r, kind: "dependency" as const, label: "pulls images" })),
      ...identityEdges(i, h),
      ...tierEdges(i, h),
    ],
  },
  azurerm_container_registry: { arm: "Microsoft.ContainerRegistry/registries", props: (i) => ({ sku: str(i.after.sku) }) },
  // AKS (lab 29): one card in its node subnet; the default node pool is a block of the cluster (its size and count on the
  // card), another pool folds in. The node resource group is Azure's: only the live view has it (made by Azure).
  azurerm_kubernetes_cluster: {
    arm: "Microsoft.ContainerService/managedClusters",
    props: (i) => {
      const pool = first(i.after.default_node_pool);
      const net = first(i.after.network_profile);
      const auto = pool.auto_scaling_enabled === true;
      const network = aksNetworkWord(str(net.network_plugin), str(net.network_plugin_mode));
      const nodeGroup = str(i.after.node_resource_group);
      return {
        tier: str(i.after.sku_tier),
        size: str(pool.vm_size),
        instances: num(pool.node_count),
        autoscale: auto && num(pool.min_count) !== undefined ? `${num(pool.min_count)}-${num(pool.max_count) ?? "?"}` : undefined,
        chips: [...(network ? [network] : []), ...(nodeGroup ? [`node group ${nodeGroup}`] : [])],
      };
    },
    edges: (i, h) => identityEdges(i, h),
  },
  azurerm_kubernetes_cluster_node_pool: { arm: "Microsoft.ContainerService/managedClusters/agentPools", fold: ["kubernetes_cluster_id"], namePath: childPath("kubernetes_cluster_id") },
  // A job: its trigger as a chip; → the namespace whose queues its KEDA rules watch (traffic, the queues' names).
  azurerm_container_app_job: {
    arm: "Microsoft.App/jobs",
    props: (i) => {
      const cs = list(first(i.after.template).container).map((c) => (c ?? {}) as Record<string, unknown>);
      const trigger = list(i.after.event_trigger_config).length ? "event-driven" : list(i.after.schedule_trigger_config).length ? "scheduled" : list(i.after.manual_trigger_config).length ? "manual" : undefined;
      return { cpu: cs.length ? Math.round(cs.reduce((a, c) => a + (num(c.cpu) ?? 0), 0) * 100) / 100 : undefined, chips: trigger ? [trigger] : undefined };
    },
    edges: (i, h) => {
      // The rules' queue names in the rules' order, so the label reads as main.tf does.
      const order = list(first(first(i.after.event_trigger_config).scale).rules).map((r) => str(((r ?? {}) as { metadata?: Record<string, unknown> }).metadata?.queueName));
      const byNs = new Map<TfInst, string[]>();
      for (const q of h.refs(i, ["event_trigger_config"]).filter((x) => x.type === "azurerm_servicebus_queue")) {
        const ns = h.refs(q, ["namespace_id"])[0];
        if (ns) byNs.set(ns, [...(byNs.get(ns) ?? []), str(q.after.name) ?? q.name]);
      }
      const label = (names: string[]) => [...order.filter((n): n is string => !!n && names.includes(n)), ...names.filter((n) => !order.includes(n))].join(", ");
      return [
        ...[...byNs].map(([ns, names]) => ({ from: i, to: ns, kind: "traffic" as const, label: label(names) })),
        ...h.refs(i, ["container_app_environment_id"]).map((e) => ({ from: i, to: e, kind: "dependency" as const, label: "environment" })),
        ...h.refs(i, ["registry"]).filter((r) => r.type === "azurerm_container_registry").map((r) => ({ from: i, to: r, kind: "dependency" as const, label: "pulls images" })),
        ...identityEdges(i, h),
      ];
    },
  },

  // ── Messaging and events (AZ-305 batch 4, lab 30) ──
  // Queues, topics, subscriptions, their rules and the access policies fold into the namespace (counts). An event
  // subscription folds into its topic and is drawn topic → destination (traffic, labelled with the destination's
  // name) and topic → dead-letter account (dependency).
  azurerm_servicebus_namespace: {
    arm: "Microsoft.ServiceBus/namespaces",
    props: (i, h) => {
      const topics = h.referrers(i, ["azurerm_servicebus_topic"], ["namespace_id"]);
      const subs = h.byType("azurerm_servicebus_subscription").filter((s) => h.refs(s, ["topic_id"]).some((t) => topics.includes(t)));
      const counts = (
        [
          ["queues", h.referrers(i, ["azurerm_servicebus_queue"], ["namespace_id"]).length],
          ["topics", topics.length],
          ["subscriptions", subs.length],
        ] as [string, number][]
      )
        .filter(([, c]) => c)
        .map(([w, c]) => `${w}: ${c}`);
      return { sku: str(i.after.sku), counts: counts.length ? counts : undefined };
    },
  },
  azurerm_servicebus_queue: { arm: "Microsoft.ServiceBus/namespaces/queues", fold: ["namespace_id"] },
  azurerm_servicebus_topic: { arm: "Microsoft.ServiceBus/namespaces/topics", fold: ["namespace_id"] },
  azurerm_servicebus_subscription: { arm: "Microsoft.ServiceBus/namespaces/topics/subscriptions", fold: ["topic_id"] },
  azurerm_servicebus_subscription_rule: { arm: "Microsoft.ServiceBus/namespaces/topics/subscriptions/rules", fold: ["subscription_id"] },
  azurerm_servicebus_namespace_authorization_rule: { arm: "Microsoft.ServiceBus/namespaces/authorizationRules", fold: ["namespace_id"] },
  azurerm_servicebus_queue_authorization_rule: { arm: "Microsoft.ServiceBus/namespaces/queues/authorizationRules", fold: ["queue_id"] },
  azurerm_servicebus_topic_authorization_rule: { arm: "Microsoft.ServiceBus/namespaces/topics/authorizationRules", fold: ["topic_id"] },
  azurerm_eventgrid_system_topic: {
    arm: "Microsoft.EventGrid/systemTopics",
    props: (i, h) => {
      const n = h.referrers(i, ["azurerm_eventgrid_system_topic_event_subscription"], ["system_topic"]).length;
      return { counts: n ? [`subscriptions: ${n}`] : undefined };
    },
    edges: (i, h) => h.refs(i, ["source_resource_id", "source_arm_resource_id"]).map((s) => ({ from: i, to: s, kind: "dependency" as const, label: "source" })),
  },
  azurerm_eventgrid_system_topic_event_subscription: {
    arm: "Microsoft.EventGrid/systemTopics/eventSubscriptions",
    fold: ["system_topic"],
    edges: (i, h) => {
      const topic = h.refs(i, ["system_topic"])[0];
      if (!topic) return [];
      const to = h.refs(i, ["service_bus_queue_endpoint_id", "service_bus_topic_endpoint_id", "eventhub_endpoint_id", "hybrid_connection_endpoint_id", "storage_queue_endpoint", "azure_function_endpoint"]);
      return [
        ...to.map((d) => ({ from: topic, to: d, kind: "traffic" as const, label: str(d.after.name) ?? "events" })),
        ...h
          .refs(i, ["storage_blob_dead_letter_destination"])
          .filter((a) => a.type === "azurerm_storage_account")
          .map((a) => ({ from: topic, to: a, kind: "dependency" as const, label: "dead-letter" })),
      ];
    },
  },

  // ── Recovery Services (T3.5): backup and site-recovery children fold into the vault; protected VMs are edges ──
  azurerm_recovery_services_vault: {
    arm: "Microsoft.RecoveryServices/vaults",
    props: (i, h) => {
      const protectedItems = h.referrers(i, ["azurerm_backup_protected_vm", "azurerm_site_recovery_replicated_vm"], ["recovery_vault_name"]).length;
      return { sku: str(i.after.sku), counts: protectedItems ? [`protected items: ${protectedItems}`] : undefined };
    },
  },
  azurerm_backup_policy_vm: { arm: "Microsoft.RecoveryServices/vaults/backupPolicies", fold: ["recovery_vault_name"] },
  azurerm_backup_protected_vm: {
    arm: "Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems",
    fold: ["recovery_vault_name"],
    edges: (i, h) => h.refs(i, ["recovery_vault_name"]).flatMap((v) => h.refs(i, ["source_vm_id"]).map((vm) => ({ from: v, to: vm, kind: "dependency" as const, label: "backup" }))),
  },
  azurerm_site_recovery_fabric: { arm: "Microsoft.RecoveryServices/vaults/replicationFabrics", fold: ["recovery_vault_name"] },
  azurerm_site_recovery_protection_container: { arm: "Microsoft.RecoveryServices/vaults/replicationFabrics/replicationProtectionContainers", fold: ["recovery_vault_name"] },
  azurerm_site_recovery_protection_container_mapping: { arm: "Microsoft.RecoveryServices/vaults/replicationFabrics/replicationProtectionContainers/replicationProtectionContainerMappings", fold: ["recovery_vault_name"] },
  azurerm_site_recovery_replication_policy: { arm: "Microsoft.RecoveryServices/vaults/replicationPolicies", fold: ["recovery_vault_name"] },
  azurerm_site_recovery_network_mapping: {
    arm: "Microsoft.RecoveryServices/vaults/replicationFabrics/replicationNetworks/replicationNetworkMappings",
    fold: ["recovery_vault_name"],
    edges: (i, h) => h.refs(i, ["source_network_id"]).flatMap((s) => h.refs(i, ["target_network_id"]).map((t) => ({ from: s, to: t, kind: "dependency" as const, label: "network mapping" }))),
  },
  azurerm_site_recovery_replicated_vm: {
    arm: "Microsoft.RecoveryServices/vaults/replicationFabrics/replicationProtectionContainers/replicationProtectedItems",
    fold: ["recovery_vault_name"],
    edges: (i, h) => h.refs(i, ["recovery_vault_name"]).flatMap((v) => h.refs(i, ["source_vm_id"]).map((vm) => ({ from: v, to: vm, kind: "dependency" as const, label: "replication" }))),
  },

  // ── Network core ──
  azurerm_network_security_group: {
    arm: "Microsoft.Network/networkSecurityGroups",
    props: (i, h) => ({ counts: [`rules: ${list(i.after.security_rule).length + h.referrers(i, ["azurerm_network_security_rule"]).length}`] }),
  },
  azurerm_network_security_rule: { arm: "Microsoft.Network/networkSecurityGroups/securityRules", fold: ["network_security_group_name"] },
  azurerm_subnet_network_security_group_association: {
    fold: ["subnet_id"],
    pull: ["network_security_group_id"],
    chips: (i, h) => h.refs(i, ["network_security_group_id"]).map((n) => ({ on: "home", chip: `NSG ${h.label(n)}` })),
  },
  azurerm_route_table: {
    arm: "Microsoft.Network/routeTables",
    props: (i, h) => ({ counts: [`routes: ${list(i.after.route).length + h.referrers(i, ["azurerm_route"]).length}`] }),
    edges: nextHopEdges,
  },
  azurerm_route: { arm: "Microsoft.Network/routeTables/routes", fold: ["route_table_name"] },
  azurerm_subnet_route_table_association: {
    fold: ["subnet_id"],
    pull: ["route_table_id"],
    chips: (i, h) => h.refs(i, ["route_table_id"]).map((n) => ({ on: "home", chip: `route table ${h.label(n)}` })),
  },
  azurerm_virtual_network_peering: {
    arm: "Microsoft.Network/virtualNetworks/virtualNetworkPeerings",
    fold: ["virtual_network_name"],
    edges: (i, h) => {
      const local = h.refs(i, ["virtual_network_name"])[0];
      const remote = h.refs(i, ["remote_virtual_network_id"])[0];
      if (!local || !remote) return [];
      const transit = i.after.allow_gateway_transit === true || i.after.use_remote_gateways === true;
      return [{ from: local, to: remote, kind: "traffic", label: transit ? "peering (gateway transit)" : "peering", undirected: true }];
    },
  },
  azurerm_public_ip: {
    arm: "Microsoft.Network/publicIPAddresses",
    // Its owner (ruling 9): what attaches it as an IP configuration. Not a local network gateway naming its address,
    // a DNS record or a Traffic Manager endpoint pointing at it: those only refer to it.
    foldToReferrer: { types: PIP_OWNERS },
    props: (i) => ({ sku: str(i.after.sku), allocation: str(i.after.allocation_method), zones: strings(i.after.zones).length ? strings(i.after.zones) : undefined }),
  },
  // Like a public IP (ruling 9): a prefix an owner uses (an LB frontend, a NAT gateway) folds into it; an unused one is a card.
  azurerm_public_ip_prefix: { arm: "Microsoft.Network/publicIPPrefixes", foldToReferrer: {}, props: (i) => ({ prefix: num(i.after.prefix_length) !== undefined ? `/${num(i.after.prefix_length)}` : undefined }) },
  azurerm_nat_gateway: { arm: "Microsoft.Network/natGateways", props: (i) => ({ sku: str(i.after.sku_name) }) },
  azurerm_nat_gateway_public_ip_association: { fold: ["nat_gateway_id"], pull: ["public_ip_address_id"] },
  azurerm_nat_gateway_public_ip_prefix_association: { fold: ["nat_gateway_id"], pull: ["public_ip_prefix_id"] },
  azurerm_subnet_nat_gateway_association: {
    fold: ["subnet_id"],
    edges: (i, h) => h.refs(i, ["subnet_id"]).flatMap((s) => h.refs(i, ["nat_gateway_id"]).map((n) => ({ from: s, to: n, kind: "traffic" as const, label: "outbound" }))),
    chips: (i, h) => h.refs(i, ["nat_gateway_id"]).map((n) => ({ on: "home", chip: `NAT gateway ${h.label(n)}` })),
  },

  // ── Load balancer (core) ──
  azurerm_lb: {
    arm: "Microsoft.Network/loadBalancers",
    props: (i) => {
      const fe = first(i.after.frontend_ip_configuration);
      return { sku: [str(i.after.sku), str(i.after.sku_tier)].filter(Boolean).join(" ") || undefined, privateIp: staticIp([{ ...fe, private_ip_address_allocation: fe.private_ip_address_allocation ?? (fe.private_ip_address ? "Static" : undefined) }]) };
    },
    // A frontend chained to a Gateway LB (gateway_load_balancer_frontend_ip_configuration_id): LB → gateway LB.
    edges: (i, h) => h.refs(i, ["frontend_ip_configuration"]).filter((t) => t.type === "azurerm_lb" && t !== i).map((t) => ({ from: i, to: t, kind: "traffic" as const, label: "chain" })),
  },
  azurerm_lb_backend_address_pool: { ...lbChildFold, arm: "Microsoft.Network/loadBalancers/backendAddressPools" },
  azurerm_lb_backend_address_pool_address: { fold: ["backend_address_pool_id"] },
  azurerm_lb_probe: { ...lbChildFold, arm: "Microsoft.Network/loadBalancers/probes" },
  azurerm_lb_rule: {
    ...lbChildFold,
    arm: "Microsoft.Network/loadBalancers/loadBalancingRules",
    edges: (i, h) => {
      const lb = h.refs(i, ["loadbalancer_id"])[0];
      if (!lb) return [];
      const label = lbRuleLabel(i.after.protocol, i.after.frontend_port, i.after.backend_port);
      return h.refs(i, ["backend_address_pool_ids"]).flatMap((p) => poolBackends(p, h).map((b) => ({ from: lb, to: `node:${b}`, kind: "traffic" as const, label })));
    },
  },
  azurerm_lb_nat_rule: {
    ...lbChildFold,
    arm: "Microsoft.Network/loadBalancers/inboundNatRules",
    edges: (i, h) => {
      const lb = h.refs(i, ["loadbalancer_id"])[0];
      if (!lb) return [];
      const fp = num(i.after.frontend_port) ?? (num(i.after.frontend_port_start) !== undefined ? `${num(i.after.frontend_port_start)}-${num(i.after.frontend_port_end)}` : "?");
      const label = `${proto(i.after.protocol)} ${fp}→${num(i.after.backend_port) ?? "?"}`;
      const viaPool = h.refs(i, ["backend_address_pool_id"]).flatMap((p) => poolBackends(p, h));
      const viaNic = h.referrers(i, ["azurerm_network_interface_nat_rule_association"]).flatMap((a) => h.refs(a, ["network_interface_id"]).map((n) => h.home(n)).filter((x): x is string => !!x));
      return [...new Set([...viaPool, ...viaNic])].sort().map((b) => ({ from: lb, to: `node:${b}`, kind: "traffic" as const, label }));
    },
  },
  azurerm_network_interface_nat_rule_association: { fold: ["nat_rule_id"] },
  azurerm_lb_outbound_rule: {
    ...lbChildFold,
    arm: "Microsoft.Network/loadBalancers/outboundRules",
    edges: (i, h) => {
      const lb = h.refs(i, ["loadbalancer_id"])[0];
      if (!lb) return [];
      return h.refs(i, ["backend_address_pool_id"]).flatMap((p) => poolBackends(p, h).map((b) => ({ from: `node:${b}`, to: lb, kind: "traffic" as const, label: "outbound" })));
    },
  },
  azurerm_network_interface_backend_address_pool_association: { fold: ["backend_address_pool_id"] },

  // ── Application gateway and WAF policies (T3.2) ──
  azurerm_application_gateway: {
    arm: "Microsoft.Network/applicationGateways",
    props: (i) => {
      const sku = first(i.after.sku);
      const auto = first(i.after.autoscale_configuration);
      const fe = list(i.after.frontend_ip_configuration).map((x) => (x ?? {}) as Record<string, unknown>).find((x) => str(x.private_ip_address));
      return {
        sku: str(sku.name),
        capacity: num(auto.min_capacity) !== undefined ? `${num(auto.min_capacity)}-${num(auto.max_capacity) ?? "?"}` : num(sku.capacity),
        privateIp: fe ? str(fe.private_ip_address) : undefined,
      };
    },
    edges: (i, h) => {
      const labels = appGwLabels(i.after);
      const label = [...labels.values()][0] ?? "HTTP";
      return [
        // Backends: the instances its pools reference (NICs, by their VM), labelled by the first rule into a pool.
        ...h.refs(i, ["backend_address_pool"]).map((t) => ({ from: i, to: t, kind: "traffic" as const, label })),
        // Pool members by address: a VM (or anything) holding that private IP.
        ...list(i.after.backend_address_pool).flatMap((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          const l = labels.get(str(o.name) ?? "") ?? label;
          return strings(o.ip_addresses)
            .map((ip) => h.nodeByPrivateIp(ip))
            .filter((x): x is string => !!x)
            .map((n) => ({ from: i, to: `node:${n}`, kind: "traffic" as const, label: l }));
        }),
        ...identityEdges(i, h),
        // Its TLS certificate from a Key Vault (the vault the certificate folds into).
        ...h.refs(i, ["ssl_certificate"]).map((c) => ({ from: i, to: c, kind: "dependency" as const, label: "TLS certificate" })),
      ];
    },
  },
  azurerm_web_application_firewall_policy: {
    arm: "Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies",
    props: (i) => ({ mode: str(first(i.after.policy_settings).mode) }),
    edges: (i, h) => h.referrers(i, ["azurerm_application_gateway"], ["firewall_policy_id"]).map((a) => ({ from: i, to: a, kind: "dependency" as const, label: "WAF policy" })),
  },

  // ── Front Door: the profile is the card (Global lane); every child folds into it (T3.2) ──
  azurerm_cdn_frontdoor_profile: { arm: "Microsoft.Cdn/profiles", props: (i) => ({ sku: str(i.after.sku_name) }) },
  azurerm_cdn_frontdoor_endpoint: { arm: "Microsoft.Cdn/profiles/afdEndpoints", fold: fdFold, namePath: childPath("cdn_frontdoor_profile_id") },
  azurerm_cdn_frontdoor_origin_group: { arm: "Microsoft.Cdn/profiles/originGroups", fold: fdFold, namePath: childPath("cdn_frontdoor_profile_id") },
  azurerm_cdn_frontdoor_origin: {
    arm: "Microsoft.Cdn/profiles/originGroups/origins",
    fold: fdFold,
    // Front Door → the origin: through Private Link (a PLS), or the resource its host name references (a container group, an LB, a public IP).
    edges: (i, h) => {
      const profile = fdProfileOf(i, h);
      if (!profile) return [];
      const pls = h.refs(i, ["private_link"]);
      if (pls.length) return pls.map((t) => ({ from: profile, to: t, kind: "traffic" as const, label: "Private Link" }));
      const routes = h.referrers(i, ["azurerm_cdn_frontdoor_route"], ["cdn_frontdoor_origin_ids"]);
      const fwd = str(routes[0]?.after.forwarding_protocol)?.toLowerCase();
      const label = fwd === "httponly" ? "HTTP" : fwd === "httpsonly" ? "HTTPS" : "HTTP/HTTPS";
      const byRef = h.refs(i, ["host_name"]).map((t) => ({ from: profile, to: t as TfInst | string, kind: "traffic" as const, label }));
      const ip = str(i.after.host_name) ? h.nodeByPrivateIp(str(i.after.host_name)!) : null;
      return byRef.length ? byRef : ip ? [{ from: profile, to: `node:${ip}`, kind: "traffic" as const, label }] : [];
    },
  },
  azurerm_cdn_frontdoor_route: { arm: "Microsoft.Cdn/profiles/afdEndpoints/routes", fold: fdFold },
  azurerm_cdn_frontdoor_rule_set: { arm: "Microsoft.Cdn/profiles/ruleSets", fold: fdFold },
  azurerm_cdn_frontdoor_rule: { arm: "Microsoft.Cdn/profiles/ruleSets/rules", fold: fdFold },
  azurerm_cdn_frontdoor_custom_domain: { arm: "Microsoft.Cdn/profiles/customDomains", fold: fdFold },
  azurerm_cdn_frontdoor_secret: { arm: "Microsoft.Cdn/profiles/secrets", fold: fdFold, foldedLabel: "secret", opaqueId: true },
  azurerm_cdn_frontdoor_security_policy: {
    arm: "Microsoft.Cdn/profiles/securityPolicies",
    fold: fdFold,
    // The WAF policy it applies: WAF policy → profile.
    edges: (i, h) => {
      const profile = h.refs(i, ["cdn_frontdoor_profile_id"])[0];
      return profile ? h.refs(i, ["security_policies"]).filter((x) => x.type === "azurerm_cdn_frontdoor_firewall_policy").map((w) => ({ from: w, to: profile, kind: "dependency" as const, label: "WAF policy" })) : [];
    },
  },
  azurerm_cdn_frontdoor_firewall_policy: { arm: "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies", props: (i) => ({ mode: str(i.after.mode), sku: str(i.after.sku_name) }) },

  // ── Traffic Manager: endpoints fold into the profile and are drawn as edges to their targets (T3.2) ──
  azurerm_traffic_manager_profile: { arm: "Microsoft.Network/trafficManagerProfiles", props: (i) => ({ routing: str(i.after.traffic_routing_method) }) },
  azurerm_traffic_manager_external_endpoint: tmEndpoint("Microsoft.Network/trafficManagerProfiles/externalEndpoints", ["target"]),
  azurerm_traffic_manager_azure_endpoint: tmEndpoint("Microsoft.Network/trafficManagerProfiles/azureEndpoints", ["target_resource_id"]),
  azurerm_traffic_manager_nested_endpoint: tmEndpoint("Microsoft.Network/trafficManagerProfiles/nestedEndpoints", ["target_resource_id"]),

  // ── Private Link service → its LB frontend (T3.2/T3.4) ──
  azurerm_private_link_service: {
    arm: "Microsoft.Network/privateLinkServices",
    edges: (i, h) => h.refs(i, ["load_balancer_frontend_ip_configuration_ids"]).map((lb) => ({ from: i, to: lb, kind: "traffic" as const, label: "frontend" })),
  },

  // ── VPN (T3.3): gateways, local network gateways, connections (folded into the gateway, drawn as edges) ──
  azurerm_virtual_network_gateway: {
    arm: "Microsoft.Network/virtualNetworkGateways",
    props: (i) => {
      const bgp = i.after.bgp_enabled === true || i.after.enable_bgp === true;
      const pool = strings(first(i.after.vpn_client_configuration).address_space);
      return { sku: str(i.after.sku), bgp, asn: bgp ? num(first(i.after.bgp_settings).asn) : undefined, vpnType: str(i.after.vpn_type), clientPool: pool.length ? pool.join(", ") : undefined };
    },
  },
  azurerm_local_network_gateway: {
    arm: "Microsoft.Network/localNetworkGateways",
    props: (i) => ({ addressSpace: strings(i.after.address_space), asn: num(first(i.after.bgp_settings).asn) }),
    // The gateway whose public address it names (a lab's simulated on-premises side is another VPN gateway).
    edges: (i, h) => h.refs(i, ["gateway_address"]).map((p) => ({ from: i, to: p, kind: "dependency" as const, label: "gateway address" })),
  },
  azurerm_virtual_network_gateway_connection: {
    arm: "Microsoft.Network/connections",
    fold: ["virtual_network_gateway_id"],
    edges: (i, h) => {
      const gw = h.refs(i, ["virtual_network_gateway_id"])[0];
      return gw ? h.refs(i, ["local_network_gateway_id", "peer_virtual_network_gateway_id", "express_route_circuit_id"]).map((t) => ({ from: gw, to: t, kind: "traffic" as const, label: connectionLabel(i) })) : [];
    },
  },

  // ── Route Server (T3.3): a virtual hub of kind RouteServer; BGP connections fold into it as BGP edges to their peer ──
  azurerm_route_server: { arm: "Microsoft.Network/virtualHubs", props: (i) => ({ sku: str(i.after.sku), asn: num(i.after.virtual_router_asn) }) },
  azurerm_route_server_bgp_connection: {
    arm: "Microsoft.Network/virtualHubs/bgpConnections",
    fold: ["route_server_id"],
    namePath: childPath("route_server_id"),
    edges: (i, h) => {
      const rs = h.refs(i, ["route_server_id"])[0];
      const to = str(i.after.peer_ip) ? h.nodeByPrivateIp(str(i.after.peer_ip)!) : null;
      return rs && to ? [{ from: rs, to: `node:${to}`, kind: "traffic" as const, label: `BGP ${num(i.after.peer_asn) ?? ""}`.trim() }] : [];
    },
  },

  // ── Firewall and policies (T3.3) ──
  azurerm_firewall: {
    arm: "Microsoft.Network/azureFirewalls",
    props: (i) => ({ tier: str(i.after.sku_tier), privateIp: staticIp(i.after.ip_configuration) }),
    edges: (i, h) => h.refs(i, ["firewall_policy_id"]).map((p) => ({ from: i, to: p, kind: "dependency" as const, label: "policy" })),
    // A secured hub's firewall lives in its virtual hub.
    place: (i, h) => h.refs(i, ["virtual_hub"]).map((x) => h.home(x)).find((x): x is string => !!x) ?? null,
  },
  azurerm_firewall_policy: {
    arm: "Microsoft.Network/firewallPolicies",
    props: (i, h) => {
      const n = h.referrers(i, ["azurerm_firewall_policy_rule_collection_group"], ["firewall_policy_id"]).length;
      return { tier: str(i.after.sku), counts: n ? [`rule collection groups: ${n}`] : undefined };
    },
    edges: (i, h) => h.refs(i, ["base_policy_id"]).map((b) => ({ from: b, to: i, kind: "dependency" as const, label: "base policy" })),
  },
  azurerm_firewall_policy_rule_collection_group: { arm: "Microsoft.Network/firewallPolicies/ruleCollectionGroups", fold: ["firewall_policy_id"], namePath: childPath("firewall_policy_id") },

  // ── Virtual WAN (T3.3): the hub is a group; its connections fold into it as edges to the spokes ──
  azurerm_virtual_wan: { arm: "Microsoft.Network/virtualWans", props: (i) => ({ sku: str(i.after.type) }) },
  azurerm_virtual_hub_connection: {
    arm: "Microsoft.Network/virtualHubs/hubVirtualNetworkConnections",
    fold: ["virtual_hub_id"],
    namePath: childPath("virtual_hub_id"),
    edges: (i, h) => h.refs(i, ["virtual_hub_id"]).flatMap((hub) => h.refs(i, ["remote_virtual_network_id"]).map((v) => ({ from: hub, to: v, kind: "traffic" as const, label: "hub connection" }))),
  },
  azurerm_virtual_hub_routing_intent: { arm: "Microsoft.Network/virtualHubs/routingIntent", fold: ["virtual_hub_id"], namePath: childPath("virtual_hub_id") },

  // ── Virtual Network Manager (T3.3): every child folds into the manager; members and connectivity as edges ──
  azurerm_network_manager: {
    arm: "Microsoft.Network/networkManagers",
    props: (i) => ({ scopeAccess: strings(i.after.scope_accesses) }),
  },
  azurerm_network_manager_network_group: { arm: "Microsoft.Network/networkManagers/networkGroups", fold: avnmFold },
  azurerm_network_manager_static_member: {
    arm: "Microsoft.Network/networkManagers/networkGroups/staticMembers",
    fold: avnmFold,
    edges: (i, h) => {
      const m = avnmManagerOf(i, h);
      return m ? h.refs(i, ["target_virtual_network_id"]).map((v) => ({ from: m, to: v, kind: "dependency" as const, label: "member" })) : [];
    },
  },
  azurerm_network_manager_connectivity_configuration: {
    arm: "Microsoft.Network/networkManagers/connectivityConfigurations",
    fold: avnmFold,
    // Hub and spoke: the peerings AVNM makes, hub ↔ each member of the groups it applies to (one per pair).
    edges: (i, h) => {
      const hubs = h.refs(i, ["hub"]);
      const members = h.refs(i, ["applies_to_group"]).flatMap((gr) => avnmMembers(gr, h));
      return hubs.flatMap((hub) => members.filter((m) => m !== hub).map((m) => ({ from: hub, to: m, kind: "traffic" as const, label: "peering (AVNM)", undirected: true })));
    },
  },
  azurerm_network_manager_security_admin_configuration: { arm: "Microsoft.Network/networkManagers/securityAdminConfigurations", fold: avnmFold },
  azurerm_network_manager_admin_rule_collection: { arm: "Microsoft.Network/networkManagers/securityAdminConfigurations/ruleCollections", fold: avnmFold },
  azurerm_network_manager_admin_rule: { arm: "Microsoft.Network/networkManagers/securityAdminConfigurations/ruleCollections/rules", fold: avnmFold },
  azurerm_network_manager_deployment: { arm: "Microsoft.Network/networkManagers/commits", fold: avnmFold },

  // ── Diagnostics and identities (T3.2 labs; T3.6 extends) ──
  // A diagnostic setting folds into the resource it watches and is drawn as resource → workspace.
  azurerm_monitor_diagnostic_setting: {
    arm: "Microsoft.Insights/diagnosticSettings",
    fold: ["target_resource_id"],
    edges: (i, h) =>
      h.refs(i, ["target_resource_id"]).flatMap((t) => h.refs(i, ["log_analytics_workspace_id", "storage_account_id", "eventhub_authorization_rule_id"]).map((w) => ({ from: t, to: w, kind: "dependency" as const, label: "diagnostics" }))),
  },
  azurerm_user_assigned_identity: { arm: "Microsoft.ManagedIdentity/userAssignedIdentities" },
  // An access policy folds into its vault and is drawn as principal → vault (its permissions are scrubbed: "access policy").
  azurerm_key_vault_access_policy: {
    arm: "Microsoft.KeyVault/vaults/accessPolicies",
    fold: ["key_vault_id"],
    edges: (i, h) => h.refs(i, ["key_vault_id"]).flatMap((v) => h.refs(i, ["object_id"]).map((p) => ({ from: p, to: v, kind: "dependency" as const, label: "access policy" }))),
  },

  // ── Template deployments (Bicep labs, ruling 24): the deployment folds into its group; its resources are expanded. ──
  azurerm_resource_group_template_deployment: { arm: "Microsoft.Resources/deployments", fold: ["resource_group_name"] },

  // ── A few plain cards with their ARM type, so keys match the live view ──
  azurerm_storage_account: {
    arm: "Microsoft.Storage/storageAccounts",
    props: (i, h) => {
      // Child collections as counts (ruling 22): containers, shares, queues, tables, blobs.
      const n = (types: string[]) => h.referrers(i, types, ["storage_account_id", "storage_account_name"]).length;
      const containers = h.referrers(i, ["azurerm_storage_container"], ["storage_account_id", "storage_account_name"]);
      const blobs = h.byType("azurerm_storage_blob").filter((b) => h.refs(b, ["storage_container_id", "storage_container_name"]).some((c) => containers.includes(c))).length;
      const counts = [["containers", containers.length], ["shares", n(["azurerm_storage_share"])], ["queues", n(["azurerm_storage_queue"])], ["tables", n(["azurerm_storage_table"])], ["blobs", blobs]]
        .filter(([, c]) => c)
        .map(([w, c]) => `${w}: ${c}`);
      return {
        accountKind: str(i.after.account_kind),
        sku: [str(i.after.account_tier), str(i.after.account_replication_type)].filter(Boolean).join(" ") || undefined,
        accessTier: str(i.after.access_tier),
        publicAccess: typeof i.after.public_network_access_enabled === "boolean" ? i.after.public_network_access_enabled : undefined,
        counts: counts.length ? counts : undefined,
      };
    },
    // The storage firewall's allowed subnets (service endpoints): subnet → account.
    edges: (i, h) => h.refs(i, ["network_rules"]).filter((s) => s.type === "azurerm_subnet").map((s) => ({ from: s, to: i, kind: "dependency" as const, label: "service endpoint" })),
  },
  azurerm_storage_share: { arm: "Microsoft.Storage/storageAccounts/fileServices/shares", fold: ["storage_account_id", "storage_account_name"] },
  azurerm_storage_queue: { arm: "Microsoft.Storage/storageAccounts/queueServices/queues", fold: ["storage_account_id", "storage_account_name"] },
  azurerm_storage_table: { arm: "Microsoft.Storage/storageAccounts/tableServices/tables", fold: ["storage_account_id", "storage_account_name"] },
  azurerm_storage_blob: { arm: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs", fold: ["storage_container_id", "storage_container_name", "storage_account_name"] },
  azurerm_storage_management_policy: { arm: "Microsoft.Storage/storageAccounts/managementPolicies", fold: ["storage_account_id"] },
  azurerm_storage_container_immutability_policy: { arm: "Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies", fold: ["storage_container_resource_manager_id", "storage_container_id"] },
  azurerm_storage_account_network_rules: {
    arm: "Microsoft.Storage/storageAccounts/networkRules",
    fold: ["storage_account_id"],
    edges: (i, h) => h.refs(i, ["storage_account_id"]).flatMap((a) => h.refs(i, ["virtual_network_subnet_ids"]).map((s) => ({ from: s, to: a, kind: "dependency" as const, label: "service endpoint" }))),
  },
  // A service endpoint policy folds into the subnets that carry it (a chip) and is drawn subnet → each resource it allows.
  azurerm_subnet_service_endpoint_storage_policy: {
    arm: "Microsoft.Network/serviceEndpointPolicies",
    foldToReferrer: { types: ["azurerm_subnet"], attrs: ["service_endpoint_policy_ids"] },
    chips: (i, h) => [{ on: "home", chip: `service endpoint policy ${h.label(i)}` }],
    edges: (i, h) => h.referrers(i, ["azurerm_subnet"], ["service_endpoint_policy_ids"]).flatMap((s) => h.refs(i, ["definition"]).map((t) => ({ from: s, to: t, kind: "dependency" as const, label: "service endpoint policy" }))),
  },

  // ── SQL (T3.4): databases are cards (status prominent) under their server's group; failover groups are edges ──
  azurerm_mssql_server: {
    arm: "Microsoft.Sql/servers",
    props: (i) => ({ publicAccess: typeof i.after.public_network_access_enabled === "boolean" ? i.after.public_network_access_enabled : undefined }),
  },
  azurerm_mssql_database: {
    arm: "Microsoft.Sql/servers/databases",
    namePath: childPath("server_id"),
    props: (i) => ({ sku: str(i.after.sku_name) }),
    edges: (i, h) => [
      ...h.refs(i, ["server_id"]).map((s) => ({ from: i, to: s, kind: "dependency" as const, label: "server" })),
      ...h.refs(i, ["creation_source_database_id"]).map((src) => ({ from: src, to: i, kind: "dependency" as const, label: str(i.after.create_mode)?.toLowerCase() === "secondary" ? "geo-replica" : "copy" })),
    ],
    // In its server's resource group (the database names no group of its own).
    place: (i, h) => {
      const server = h.refs(i, ["server_id"])[0];
      const rg = str(server?.after.resource_group_name)?.toLowerCase();
      const r = rg ? h.byType("azurerm_resource_group").find((x) => str(x.after.name)?.toLowerCase() === rg) : undefined;
      return r ? h.home(r) : null;
    },
  },
  azurerm_mssql_failover_group: {
    arm: "Microsoft.Sql/servers/failoverGroups",
    fold: ["server_id"],
    namePath: childPath("server_id"),
    edges: (i, h) => h.refs(i, ["server_id"]).flatMap((s) => h.refs(i, ["partner_server"]).map((p) => ({ from: s, to: p, kind: "dependency" as const, label: "failover group" }))),
  },
  azurerm_mssql_firewall_rule: { arm: "Microsoft.Sql/servers/firewallRules", fold: ["server_id"] },
  azurerm_mssql_virtual_network_rule: { arm: "Microsoft.Sql/servers/virtualNetworkRules", fold: ["server_id"] },

  // ── Cosmos DB (T3.4): databases and containers fold into the account (counted) ──
  azurerm_cosmosdb_account: {
    arm: "Microsoft.DocumentDB/databaseAccounts",
    props: (i, h) => {
      const caps = list(i.after.capabilities).map((c) => str((c as Record<string, unknown>)?.name) ?? "");
      const dbs = h.referrers(i, ["azurerm_cosmosdb_sql_database", "azurerm_cosmosdb_mongo_database", "azurerm_cosmosdb_cassandra_keyspace", "azurerm_cosmosdb_gremlin_database"], ["account_name"]).length;
      const cs = h.referrers(i, ["azurerm_cosmosdb_sql_container", "azurerm_cosmosdb_mongo_collection", "azurerm_cosmosdb_cassandra_table", "azurerm_cosmosdb_gremlin_graph", "azurerm_cosmosdb_table"], ["account_name"]).length;
      const counts = [["databases", dbs], ["containers", cs]].filter(([, c]) => c).map(([w, c]) => `${w}: ${c}`);
      return { apiKind: cosmosApi(str(i.after.kind), caps), consistency: str(first(i.after.consistency_policy).consistency_level), counts: counts.length ? counts : undefined };
    },
  },
  azurerm_cosmosdb_sql_database: { arm: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases", fold: ["account_name"] },
  azurerm_cosmosdb_sql_container: { arm: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers", fold: ["database_name", "account_name"] },
  azurerm_cosmosdb_mongo_database: { arm: "Microsoft.DocumentDB/databaseAccounts/mongodbDatabases", fold: ["account_name"] },
  azurerm_cosmosdb_mongo_collection: { arm: "Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections", fold: ["database_name", "account_name"] },
  // ── Key Vault (core; T3.4 extends): child objects are counts, never names (ruling 22) ──
  azurerm_key_vault: {
    arm: "Microsoft.KeyVault/vaults",
    props: (i, h) => {
      const n = (t: string) => h.referrers(i, [t], ["key_vault_id"]).length;
      const counts = [["certificates", n("azurerm_key_vault_certificate")], ["keys", n("azurerm_key_vault_key")], ["secrets", n("azurerm_key_vault_secret")]].filter(([, c]) => c).map(([w, c]) => `${w}: ${c}`);
      const rbac = i.after.enable_rbac_authorization === true || i.after.rbac_authorization_enabled === true;
      return { sku: str(i.after.sku_name), mode: rbac ? "RBAC" : "access policies", counts: counts.length ? counts : undefined };
    },
  },
  azurerm_key_vault_secret: { arm: "Microsoft.KeyVault/vaults/secrets", fold: ["key_vault_id"], foldedLabel: "secret", opaqueId: true },
  azurerm_key_vault_key: { arm: "Microsoft.KeyVault/vaults/keys", fold: ["key_vault_id"], foldedLabel: "key", opaqueId: true },
  azurerm_key_vault_certificate: { arm: "Microsoft.KeyVault/vaults/certificates", fold: ["key_vault_id"], foldedLabel: "certificate", opaqueId: true },

  azurerm_storage_container: { arm: "Microsoft.Storage/storageAccounts/blobServices/containers", fold: ["storage_account_id", "storage_account_name"] },

  // ── Private access (core; T3.4 extends) ──
  azurerm_private_endpoint: {
    arm: "Microsoft.Network/privateEndpoints",
    props: (i) => {
      const c = first(i.after.private_service_connection);
      return { groupId: strings(c.subresource_names)[0], privateIp: str(first(i.after.ip_configuration).private_ip_address) };
    },
    edges: (i, h) => {
      const c = first(i.after.private_service_connection);
      return [
        ...h.refs(i, ["private_service_connection"]).map((t) => ({ from: i, to: t, kind: "traffic" as const, label: strings(c.subresource_names)[0] ?? "private link" })),
        // Its DNS zone group: the private zones that hold its address.
        ...h.refs(i, ["private_dns_zone_group"]).filter((z) => z.type === "azurerm_private_dns_zone").map((z) => ({ from: i, to: z, kind: "dependency" as const, label: "DNS zone group" })),
      ];
    },
  },
  azurerm_private_dns_zone: { arm: "Microsoft.Network/privateDnsZones", props: (i, h) => ({ counts: recordCount(i, h, "azurerm_private_dns_") }) },
  azurerm_dns_zone: { arm: "Microsoft.Network/dnszones", props: (i, h) => ({ counts: recordCount(i, h, "azurerm_dns_") }) },
  ...recordRules(),

  // ── DNS private resolver (lab 32): endpoints fold into the resolver, rules and links into the ruleset ──
  azurerm_private_dns_resolver: {
    arm: "Microsoft.Network/dnsResolvers",
    props: (i, h) => ({ privateIp: h.referrers(i, ["azurerm_private_dns_resolver_inbound_endpoint"], ["private_dns_resolver_id"]).map((e) => staticIp(e.after.ip_configurations))[0] }),
  },
  azurerm_private_dns_resolver_inbound_endpoint: { arm: "Microsoft.Network/dnsResolvers/inboundEndpoints", fold: ["private_dns_resolver_id"], namePath: childPath("private_dns_resolver_id") },
  azurerm_private_dns_resolver_outbound_endpoint: { arm: "Microsoft.Network/dnsResolvers/outboundEndpoints", fold: ["private_dns_resolver_id"], namePath: childPath("private_dns_resolver_id") },
  azurerm_private_dns_resolver_dns_forwarding_ruleset: {
    arm: "Microsoft.Network/dnsForwardingRulesets",
    props: (i, h) => {
      const n = h.referrers(i, ["azurerm_private_dns_resolver_forwarding_rule"], ["dns_forwarding_ruleset_id"]).length;
      return { counts: n ? [`rules: ${n}`] : undefined };
    },
    edges: (i, h) => h.refs(i, ["private_dns_resolver_outbound_endpoint_ids"]).map((o) => ({ from: i, to: o, kind: "dependency" as const, label: "outbound endpoint" })),
  },
  azurerm_private_dns_resolver_forwarding_rule: {
    arm: "Microsoft.Network/dnsForwardingRulesets/forwardingRules",
    fold: ["dns_forwarding_ruleset_id"],
    namePath: childPath("dns_forwarding_ruleset_id"),
    // The DNS forward edge: the ruleset → the server each target IP is (a VM's static IP), port as the label.
    edges: (i, h) => {
      const rs = h.refs(i, ["dns_forwarding_ruleset_id"])[0];
      if (!rs) return [];
      return list(i.after.target_dns_servers).flatMap((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const to = str(o.ip_address) ? h.nodeByPrivateIp(str(o.ip_address)!) : null;
        return to ? [{ from: rs, to: `node:${to}`, kind: "traffic" as const, label: `DNS ${num(o.port) ?? 53}` }] : [];
      });
    },
  },
  azurerm_private_dns_resolver_virtual_network_link: {
    arm: "Microsoft.Network/dnsForwardingRulesets/virtualNetworkLinks",
    fold: ["dns_forwarding_ruleset_id"],
    namePath: childPath("dns_forwarding_ruleset_id"),
    edges: (i, h) => h.refs(i, ["dns_forwarding_ruleset_id"]).flatMap((rs) => h.refs(i, ["virtual_network_id"]).map((v) => ({ from: rs, to: v, kind: "dependency" as const, label: "link" }))),
  },
  azurerm_private_dns_zone_virtual_network_link: {
    arm: "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
    fold: ["private_dns_zone_name"],
    namePath: (i, h) => [h.refs(i, ["private_dns_zone_name"])[0]?.after.name as string ?? "", str(i.after.name) ?? i.name],
    edges: (i, h) =>
      h.refs(i, ["private_dns_zone_name"]).flatMap((z) => h.refs(i, ["virtual_network_id"]).map((v) => ({ from: z, to: v, kind: "dependency" as const, label: i.after.registration_enabled === true ? "link (auto-registration)" : "link" }))),
  },

  // ── Identity (core; T3.4 and T3.6 extend) ──
  azurerm_role_assignment: {
    arm: "Microsoft.Authorization/roleAssignments",
    fold: ["scope"],
    edges: (i, h) => {
      // The role's name, or a custom role definition's (by reference); a scope that is one vault object says so (never which).
      const def = h.refs(i, ["role_definition_id"]).find((d) => d.type === "azurerm_role_definition");
      const name = str(i.after.role_definition_name) ?? (def ? h.label(def) : "custom");
      return h.refs(i, ["principal_id"]).flatMap((p) =>
        h.refs(i, ["scope"]).map((s) => {
          const one = s.type === "azurerm_key_vault_secret" ? " (one secret)" : s.type === "azurerm_key_vault_key" ? " (one key)" : s.type === "azurerm_key_vault_certificate" ? " (one certificate)" : "";
          // An AKS cluster whose control plane has a user-assigned identity (its own card) can only be the principal
          // through its kubelet identity, which AKS makes in the node group and the cluster's card stands for (lab 29).
          const kubelet = p.type === "azurerm_kubernetes_cluster" && str(first(p.after.identity).type) === "UserAssigned" ? " (kubelet identity)" : "";
          return { from: p, to: s, kind: "dependency" as const, label: `role: ${name}${one}${kubelet}` };
        }),
      );
    },
  },
  // Entra groups (Tenant lane, planned only): each member → the group.
  azuread_group: { kind: "entraPrincipal", edges: (i, h) => h.refs(i, ["members"]).map((m) => ({ from: m, to: i, kind: "dependency" as const, label: "member" })) },
  azuread_user: { kind: "entraPrincipal" },
  azuread_group_member: {
    fold: ["group_object_id"],
    edges: (i, h) => h.refs(i, ["group_object_id"]).flatMap((gr) => h.refs(i, ["member_object_id"]).map((m) => ({ from: m, to: gr, kind: "dependency" as const, label: "member" }))),
  },

  // ── Governance (T3.6): management groups, policy and roles in the Tenant lane; RG-scoped assignments in their RG ──
  azurerm_management_group: {
    arm: "Microsoft.Management/managementGroups",
    edges: (i, h) => h.refs(i, ["parent_management_group_id"]).map((p) => ({ from: i, to: p, kind: "dependency" as const, label: "parent" })),
  },
  azurerm_policy_definition: { arm: "Microsoft.Authorization/policyDefinitions", props: (i) => ({ effect: policyEffect(i.after.parameters, true) }) },
  azurerm_policy_set_definition: { arm: "Microsoft.Authorization/policySetDefinitions", edges: (i, h) => policySetEdges(i, h) },
  azurerm_management_group_policy_set_definition: { arm: "Microsoft.Authorization/policySetDefinitions", edges: (i, h) => policySetEdges(i, h) },
  azurerm_resource_group_policy_assignment: policyAssignment(),
  azurerm_management_group_policy_assignment: policyAssignment("management_group_id"),
  azurerm_subscription_policy_assignment: policyAssignment(),
  azurerm_resource_policy_assignment: policyAssignment("resource_id"),
  azurerm_role_definition: { arm: "Microsoft.Authorization/roleDefinitions" },
  // A lock folds into what it locks, as a chip there (an RG lock: a chip on the group).
  azurerm_management_lock: {
    arm: "Microsoft.Authorization/locks",
    fold: ["scope"],
    chips: (i) => [{ on: "home", chip: `lock ${str(i.after.lock_level) ?? ""}`.trim() }],
  },
  // A budget folds into its group as a chip; its alerts are an edge group → action group.
  azurerm_consumption_budget_resource_group: {
    arm: "Microsoft.Consumption/budgets",
    fold: ["resource_group_id"],
    chips: (i) => [{ on: "home", chip: `budget ${num(i.after.amount) ?? ""}`.trim() }],
    edges: (i, h) => h.refs(i, ["resource_group_id"]).flatMap((rg) => h.refs(i, ["notification"]).filter((x) => x.type === "azurerm_monitor_action_group").map((a) => ({ from: rg, to: a, kind: "dependency" as const, label: "budget alert" }))),
  },

  // ── Monitoring (T3.6) ──
  azurerm_log_analytics_workspace: { arm: "Microsoft.OperationalInsights/workspaces", props: (i) => ({ retentionDays: num(i.after.retention_in_days), dailyCapGb: num(i.after.daily_quota_gb) }) },
  azurerm_monitor_action_group: { arm: "Microsoft.Insights/actionGroups" },
  azurerm_monitor_metric_alert: { arm: "Microsoft.Insights/metricAlerts", edges: (i, h) => alertEdges(i, h) },
  azurerm_monitor_activity_log_alert: { arm: "Microsoft.Insights/activityLogAlerts", edges: (i, h) => alertEdges(i, h) },
  azurerm_monitor_scheduled_query_rules_alert_v2: { arm: "Microsoft.Insights/scheduledQueryRules", edges: (i, h) => alertEdges(i, h) },
  azurerm_monitor_data_collection_endpoint: { arm: "Microsoft.Insights/dataCollectionEndpoints" },
  azurerm_monitor_data_collection_rule: {
    arm: "Microsoft.Insights/dataCollectionRules",
    edges: (i, h) => h.refs(i, ["destinations"]).map((w) => ({ from: i, to: w, kind: "dependency" as const, label: "sends to" })),
  },
  // The association folds into its rule and is drawn rule → the resource it collects from.
  azurerm_monitor_data_collection_rule_association: {
    arm: "Microsoft.Insights/dataCollectionRuleAssociations",
    fold: ["data_collection_rule_id", "data_collection_endpoint_id"],
    edges: (i, h) => h.refs(i, ["data_collection_rule_id"]).flatMap((r) => h.refs(i, ["target_resource_id"]).map((t) => ({ from: r, to: t, kind: "dependency" as const, label: "collects from" }))),
  },
  // A flow log lives in NetworkWatcherRG (outside the lab): drawn there, with edges to what it watches and where it writes.
  azurerm_network_watcher_flow_log: {
    arm: "Microsoft.Network/networkWatchers/flowLogs",
    namePath: (i) => [str(i.after.network_watcher_name) ?? "", nameOf(i)],
    props: (i) => ({ retentionDays: first(i.after.retention_policy).enabled === false ? undefined : num(first(i.after.retention_policy).days) }),
    edges: (i, h) => [
      ...h.refs(i, ["target_resource_id", "network_security_group_id"]).map((t) => ({ from: i, to: t, kind: "dependency" as const, label: "watches" })),
      ...h.refs(i, ["storage_account_id"]).map((t) => ({ from: i, to: t, kind: "dependency" as const, label: "stores logs" })),
      ...h.refs(i, ["traffic_analytics"]).map((t) => ({ from: i, to: t, kind: "dependency" as const, label: "traffic analytics" })),
    ],
  },
  azurerm_bastion_host: { arm: "Microsoft.Network/bastionHosts", props: (i) => ({ sku: str(i.after.sku) }) },
};

/** The rule for a type ({} when none). */
export const tfRule = (type: string): TfRule => TF_RULES[type] ?? {};

/** True for a type that is never drawn. */
export const tfIgnored = (type: string): boolean => TF_IGNORED_PREFIXES.some((p) => type.startsWith(p)) || TF_RULES[type]?.ignore === true;

export { VM_TYPES };
