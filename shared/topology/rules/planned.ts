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

/** Every route of a route table instance: inline `route` blocks, and azurerm_route resources naming it. */
function routesOf(rt: TfInst, h: PlannedHelpers): { via: TfInst; prefix?: string; hopType?: string; hopIp?: string }[] {
  const out: { via: TfInst; prefix?: string; hopType?: string; hopIp?: string }[] = [];
  for (const r of list(rt.after.route)) {
    const o = (r ?? {}) as Record<string, unknown>;
    out.push({ via: rt, prefix: str(o.address_prefix), hopType: str(o.next_hop_type), hopIp: str(o.next_hop_in_ip_address) });
  }
  for (const r of h.referrers(rt, ["azurerm_route"], ["route_table_name"])) out.push({ via: r, prefix: str(r.after.address_prefix), hopType: str(r.after.next_hop_type), hopIp: str(r.after.next_hop_in_ip_address) });
  return out;
}

/** The next-hop edges of a route table: from each subnet it serves (or the table's own card) to the appliance holding the hop IP. */
function nextHopEdges(rt: TfInst, h: PlannedHelpers): EdgeSpec[] {
  const assoc = h.referrers(rt, ["azurerm_subnet_route_table_association"], ["route_table_id"]);
  const subnets = assoc.flatMap((a) => h.refs(a, ["subnet_id"]));
  const froms: (TfInst | string)[] = subnets.length ? subnets : [rt];
  const out: EdgeSpec[] = [];
  for (const r of routesOf(rt, h)) {
    if (r.hopType?.toLowerCase() !== "virtualappliance" || !r.hopIp) continue;
    const to = h.nodeByPrivateIp(r.hopIp);
    if (!to) continue;
    for (const from of froms) out.push({ from, to, kind: "traffic", label: r.prefix ?? "route", via: r.via });
  }
  return out;
}

/** The homes of an LB backend pool's members: NICs associated with it, and anything (a VMSS) that references it. */
function poolBackends(pool: TfInst, h: PlannedHelpers): string[] {
  const out = new Set<string>();
  for (const a of h.referrers(pool, ["azurerm_network_interface_backend_address_pool_association"], ["backend_address_pool_id"])) {
    for (const nic of h.refs(a, ["network_interface_id"])) {
      const home = h.home(nic);
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

const lbChildFold: TfRule = { fold: ["loadbalancer_id"], arm: undefined };

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
  azurerm_virtual_hub: { arm: "Microsoft.Network/virtualHubs", props: (i) => ({ prefix: str(i.after.address_prefix), sku: str(i.after.sku) }) },

  // ── Compute ──
  azurerm_linux_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps("Linux") },
  azurerm_windows_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps("Windows") },
  azurerm_virtual_machine: { arm: "Microsoft.Compute/virtualMachines", props: vmProps("") },
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
    foldToReferrer: {},
    props: (i) => ({ sku: str(i.after.sku), allocation: str(i.after.allocation_method), zones: strings(i.after.zones).length ? strings(i.after.zones) : undefined }),
  },
  azurerm_public_ip_prefix: { arm: "Microsoft.Network/publicIPPrefixes", props: (i) => ({ prefix: num(i.after.prefix_length) !== undefined ? `/${num(i.after.prefix_length)}` : undefined }) },
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
      const label = `${proto(i.after.protocol)} ${num(i.after.frontend_port) ?? "?"}→${num(i.after.backend_port) ?? "?"}`;
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

  // ── Template deployments (Bicep labs, ruling 24): the deployment folds into its group; its resources are expanded. ──
  azurerm_resource_group_template_deployment: { arm: "Microsoft.Resources/deployments", fold: ["resource_group_name"] },

  // ── A few plain cards with their ARM type, so keys match the live view ──
  azurerm_storage_account: {
    arm: "Microsoft.Storage/storageAccounts",
    props: (i) => ({
      accountKind: str(i.after.account_kind),
      sku: [str(i.after.account_tier), str(i.after.account_replication_type)].filter(Boolean).join(" ") || undefined,
      accessTier: str(i.after.access_tier),
      publicAccess: typeof i.after.public_network_access_enabled === "boolean" ? i.after.public_network_access_enabled : undefined,
    }),
  },
  azurerm_log_analytics_workspace: { arm: "Microsoft.OperationalInsights/workspaces", props: (i) => ({ retentionDays: num(i.after.retention_in_days), dailyCapGb: num(i.after.daily_quota_gb) }) },
  azurerm_network_watcher_flow_log: { arm: "Microsoft.Network/networkWatchers/flowLogs" },
};

/** The rule for a type ({} when none). */
export const tfRule = (type: string): TfRule => TF_RULES[type] ?? {};

/** True for a type that is never drawn. */
export const tfIgnored = (type: string): boolean => TF_IGNORED_PREFIXES.some((p) => type.startsWith(p)) || TF_RULES[type]?.ignore === true;

export { VM_TYPES };
