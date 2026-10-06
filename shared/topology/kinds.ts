// shared/topology/kinds.ts
//
// Plain English: the registry of what can appear on a lab diagram (lab
// topology spec §4.2-§4.3). Each kind says its words, its icon (a symbol in
// the Azure icon sprite, web/src/views/labs/topology/icons/azure.svg), where
// it sits (inside a subnet, a VNet, its resource group, the Global or Tenant
// lane, or the root), whether the one live Resource Graph query can list it,
// which ARM and Terraform types it covers, the 1-2 props its card shows and
// its packing order inside a container (edge devices, compute, data, the
// rest, generic last).
//
// Anything not listed is `generic`: a resource is never dropped.

import type { TopoAssetKind, TopoGroupKind, TopoKind } from "./model";
import { TOPO_GROUP_KINDS } from "./model";

export type KindPlacement = "subnet" | "vnet" | "rg" | "global" | "tenant" | "root";

export interface KindDef {
  word: string;
  plural: string;
  /** Symbol id in the sprite, without its "az-" prefix. */
  icon: string;
  placement: KindPlacement;
  /** False: the live query never lists it (policy and role objects, management groups, Entra principals). */
  liveVisible: boolean;
  armTypes: string[];
  /** Terraform types; a trailing "*" matches a prefix. */
  tfTypes: string[];
  /** PROP_NAMES the card shows, most important first. */
  cardProps: string[];
  /** Packing order inside a container: lower first. */
  order: number;
}

const def = (word: string, plural: string, icon: string, placement: KindPlacement, order: number, armTypes: string[], tfTypes: string[], cardProps: string[], liveVisible = true): KindDef => ({
  word,
  plural,
  icon,
  placement,
  liveVisible,
  armTypes,
  tfTypes,
  cardProps,
  order,
});

// Order bands: edge devices 10-19, compute 20-29, data 30-39, everything else 40-79, generic 99. Groups 0-5.
export const KINDS: Record<TopoKind, KindDef> = {
  // ── Groups ──
  resourceGroup: def("Resource group", "Resource groups", "resource-groups", "root", 0, ["Microsoft.Resources/resourceGroups"], ["azurerm_resource_group"], ["region", "chips", "tags"]),
  vnet: def("Virtual network", "Virtual networks", "virtual-networks", "rg", 1, ["Microsoft.Network/virtualNetworks"], ["azurerm_virtual_network"], ["addressSpace", "dnsServers"]),
  subnet: def("Subnet", "Subnets", "subnet", "vnet", 2, ["Microsoft.Network/virtualNetworks/subnets"], ["azurerm_subnet"], ["prefix", "chips"]),
  virtualHub: def("Virtual hub", "Virtual hubs", "virtual-wan-hub", "rg", 3, ["Microsoft.Network/virtualHubs"], ["azurerm_virtual_hub"], ["prefix", "sku", "routing"]),
  lane: def("Lane", "Lanes", "management-groups", "root", 4, [], [], []),

  // ── Edge devices ──
  firewall: def("Firewall", "Firewalls", "firewalls", "subnet", 10, ["Microsoft.Network/azureFirewalls"], ["azurerm_firewall"], ["tier", "privateIp"]),
  vpnGateway: def("VPN gateway", "VPN gateways", "virtual-network-gateways", "subnet", 11, ["Microsoft.Network/virtualNetworkGateways"], ["azurerm_virtual_network_gateway"], ["sku", "asn"]),
  appGateway: def("Application gateway", "Application gateways", "application-gateways", "subnet", 12, ["Microsoft.Network/applicationGateways"], ["azurerm_application_gateway"], ["sku", "capacity"]),
  loadBalancer: def("Load balancer", "Load balancers", "load-balancers", "rg", 13, ["Microsoft.Network/loadBalancers"], ["azurerm_lb"], ["sku", "privateIp", "publicIp"]),
  bastion: def("Bastion", "Bastions", "bastions", "subnet", 14, ["Microsoft.Network/bastionHosts"], ["azurerm_bastion_host"], ["sku"]),
  routeServer: def("Route Server", "Route Servers", "route-server", "subnet", 15, [], ["azurerm_route_server"], ["asn", "privateIp"]),
  natGateway: def("NAT gateway", "NAT gateways", "nat", "rg", 16, ["Microsoft.Network/natGateways"], ["azurerm_nat_gateway"], ["sku", "publicIp"]),

  // ── Compute ──
  vm: def("VM", "VMs", "virtual-machine", "subnet", 20, ["Microsoft.Compute/virtualMachines"], ["azurerm_linux_virtual_machine", "azurerm_windows_virtual_machine", "azurerm_virtual_machine"], ["size", "privateIp"]),
  vmss: def("VM scale set", "VM scale sets", "vm-scale-sets", "subnet", 21, ["Microsoft.Compute/virtualMachineScaleSets"], ["azurerm_linux_virtual_machine_scale_set", "azurerm_windows_virtual_machine_scale_set", "azurerm_orchestrated_virtual_machine_scale_set"], ["size", "instances", "autoscale"]),
  containerGroup: def("Container group", "Container groups", "container-instances", "subnet", 22, ["Microsoft.ContainerInstance/containerGroups"], ["azurerm_container_group"], ["cpu", "memoryGb"]),
  containerApp: def("Container app", "Container apps", "container-apps", "rg", 23, ["Microsoft.App/containerApps"], ["azurerm_container_app"], ["ingress", "targetPort"]),
  containerAppEnv: def("Container Apps environment", "Container Apps environments", "container-apps-environments", "subnet", 24, ["Microsoft.App/managedEnvironments"], ["azurerm_container_app_environment"], ["sku"]),
  appServicePlan: def("App Service plan", "App Service plans", "app-service-plans", "rg", 25, ["Microsoft.Web/serverFarms"], ["azurerm_service_plan"], ["sku"]),

  // ── Data ──
  storage: def("Storage account", "Storage accounts", "storage-accounts", "rg", 30, ["Microsoft.Storage/storageAccounts"], ["azurerm_storage_account"], ["accountKind", "publicAccess"]),
  sqlServer: def("SQL server", "SQL servers", "sql-server", "rg", 31, ["Microsoft.Sql/servers"], ["azurerm_mssql_server"], ["publicAccess"]),
  sqlDatabase: def("SQL database", "SQL databases", "sql-database", "rg", 32, ["Microsoft.Sql/servers/databases"], ["azurerm_mssql_database"], ["status", "sku"]),
  cosmos: def("Cosmos DB account", "Cosmos DB accounts", "azure-cosmos-db", "rg", 33, ["Microsoft.DocumentDB/databaseAccounts"], ["azurerm_cosmosdb_account"], ["status", "apiKind", "consistency"]),
  keyVault: def("Key vault", "Key vaults", "key-vaults", "rg", 34, ["Microsoft.KeyVault/vaults"], ["azurerm_key_vault"], ["sku", "counts"]),
  registry: def("Container registry", "Container registries", "container-registries", "rg", 35, ["Microsoft.ContainerRegistry/registries"], ["azurerm_container_registry"], ["sku"]),

  // ── Everything else ──
  privateEndpoint: def("Private endpoint", "Private endpoints", "private-endpoints", "subnet", 40, ["Microsoft.Network/privateEndpoints"], ["azurerm_private_endpoint"], ["groupId", "privateIp"]),
  privateLinkService: def("Private Link service", "Private Link services", "private-link-services", "subnet", 41, ["Microsoft.Network/privateLinkServices"], ["azurerm_private_link_service"], ["privateIp"]),
  publicIp: def("Public IP", "Public IPs", "public-ip-addresses", "rg", 42, ["Microsoft.Network/publicIPAddresses"], ["azurerm_public_ip"], ["sku", "publicIp"]),
  publicIpPrefix: def("Public IP prefix", "Public IP prefixes", "public-ip-prefixes", "rg", 43, ["Microsoft.Network/publicIPPrefixes"], ["azurerm_public_ip_prefix"], ["prefix"]),
  localNetworkGateway: def("Local network gateway", "Local network gateways", "local-network-gateways", "rg", 44, ["Microsoft.Network/localNetworkGateways"], ["azurerm_local_network_gateway"], ["addressSpace", "asn"]),
  wafPolicy: def("WAF policy", "WAF policies", "web-application-firewall-policies", "rg", 45, ["Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies", "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies"], ["azurerm_web_application_firewall_policy", "azurerm_cdn_frontdoor_firewall_policy"], ["mode"]),
  firewallPolicy: def("Firewall policy", "Firewall policies", "firewall-policies", "rg", 46, ["Microsoft.Network/firewallPolicies"], ["azurerm_firewall_policy"], ["tier", "counts"]),
  dnsResolver: def("DNS private resolver", "DNS private resolvers", "dns-private-resolver", "vnet", 47, ["Microsoft.Network/dnsResolvers"], ["azurerm_private_dns_resolver"], ["privateIp"]),
  dnsRuleset: def("DNS forwarding ruleset", "DNS forwarding rulesets", "dns-forwarding-ruleset", "rg", 48, ["Microsoft.Network/dnsForwardingRulesets"], ["azurerm_private_dns_resolver_dns_forwarding_ruleset"], ["counts"]),
  dnsZone: def("DNS zone", "DNS zones", "dns-zones", "global", 49, ["Microsoft.Network/dnszones"], ["azurerm_dns_zone"], ["counts"]),
  privateDnsZone: def("Private DNS zone", "Private DNS zones", "private-dns-zones", "rg", 50, ["Microsoft.Network/privateDnsZones"], ["azurerm_private_dns_zone"], ["counts"]),
  frontDoor: def("Front Door", "Front Doors", "front-door", "global", 51, ["Microsoft.Cdn/profiles"], ["azurerm_cdn_frontdoor_profile"], ["sku", "hostName"]),
  trafficManager: def("Traffic Manager profile", "Traffic Manager profiles", "traffic-manager-profiles", "global", 52, ["Microsoft.Network/trafficManagerProfiles"], ["azurerm_traffic_manager_profile"], ["routing"]),
  logAnalytics: def("Log Analytics workspace", "Log Analytics workspaces", "log-analytics-workspaces", "rg", 53, ["Microsoft.OperationalInsights/workspaces"], ["azurerm_log_analytics_workspace"], ["dailyCapGb", "retentionDays"]),
  monitor: def(
    "Monitor resource",
    "Monitor resources",
    "monitor",
    "rg",
    54,
    ["Microsoft.Insights/metricAlerts", "Microsoft.Insights/activityLogAlerts", "Microsoft.Insights/actionGroups", "Microsoft.Insights/dataCollectionRules", "Microsoft.Insights/dataCollectionEndpoints", "Microsoft.Insights/scheduledQueryRules"],
    ["azurerm_monitor_*"],
    ["status"],
  ),
  recoveryVault: def("Recovery Services vault", "Recovery Services vaults", "recovery-services-vaults", "rg", 55, ["Microsoft.RecoveryServices/vaults"], ["azurerm_recovery_services_vault"], ["sku", "counts"]),
  networkManager: def("Virtual network manager", "Virtual network managers", "network-managers", "rg", 56, ["Microsoft.Network/networkManagers"], ["azurerm_network_manager"], ["scopeAccess"]),
  virtualWan: def("Virtual WAN", "Virtual WANs", "virtual-wans", "rg", 57, ["Microsoft.Network/virtualWans"], ["azurerm_virtual_wan"], ["sku"]),
  managedIdentity: def("Managed identity", "Managed identities", "managed-identities", "rg", 58, ["Microsoft.ManagedIdentity/userAssignedIdentities"], ["azurerm_user_assigned_identity"], []),
  nsg: def("Network security group", "Network security groups", "network-security-groups", "rg", 59, ["Microsoft.Network/networkSecurityGroups"], ["azurerm_network_security_group"], ["counts"]),
  routeTable: def("Route table", "Route tables", "route-tables", "rg", 60, ["Microsoft.Network/routeTables"], ["azurerm_route_table"], ["counts"]),
  managementGroup: def("Management group", "Management groups", "management-groups", "tenant", 61, ["Microsoft.Management/managementGroups"], ["azurerm_management_group"], [], false),
  policy: def(
    "Policy",
    "Policies",
    "policy",
    "rg",
    62,
    ["Microsoft.Authorization/policyDefinitions", "Microsoft.Authorization/policySetDefinitions", "Microsoft.Authorization/policyAssignments"],
    ["azurerm_policy_definition", "azurerm_policy_set_definition", "azurerm_management_group_policy_set_definition", "*_policy_assignment"],
    ["effect", "enforcement"],
    false,
  ),
  role: def("Role definition", "Role definitions", "role", "tenant", 63, ["Microsoft.Authorization/roleDefinitions"], ["azurerm_role_definition"], [], false),
  entraPrincipal: def("Entra principal", "Entra principals", "users", "tenant", 64, [], ["azuread_user", "azuread_group"], [], false),
  gateway: def("WireGuard gateway", "WireGuard gateways", "virtual-networks", "root", 70, [], [], []),
  generic: def("Resource", "Resources", "generic", "rg", 99, [], [], []),
};

export const GROUP_KINDS: readonly TopoGroupKind[] = TOPO_GROUP_KINDS;

/** Big labs (ruling 19): more than this many assets of one kind in one container become a stack card. */
export const STACK_AT = 8;
/** A graph with more nodes than this opens in the List view. */
export const LIST_VIEW_AT = 300;

const ARM_INDEX = new Map<string, TopoKind>();
for (const [k, d] of Object.entries(KINDS) as [TopoKind, KindDef][]) for (const t of d.armTypes) ARM_INDEX.set(t.toLowerCase(), k);

/** The kind of an ARM type (case-insensitive); a virtual hub of kind RouteServer is a routeServer. Unknown: generic. */
export function kindOfArm(type: string, kind?: string | null): TopoKind {
  const t = type.toLowerCase();
  if (t === "microsoft.network/virtualhubs" && (kind ?? "").toLowerCase() === "routeserver") return "routeServer";
  return ARM_INDEX.get(t) ?? "generic";
}

const TF_EXACT = new Map<string, TopoKind>();
const TF_PATTERNS: [string, TopoKind, "prefix" | "suffix"][] = [];
for (const [k, d] of Object.entries(KINDS) as [TopoKind, KindDef][]) {
  for (const t of d.tfTypes) {
    if (t.endsWith("*")) TF_PATTERNS.push([t.slice(0, -1), k, "prefix"]);
    else if (t.startsWith("*")) TF_PATTERNS.push([t.slice(1), k, "suffix"]);
    else TF_EXACT.set(t, k);
  }
}

/** The kind of a Terraform resource type. Unknown: generic. */
export function kindOfTf(type: string): TopoKind {
  const exact = TF_EXACT.get(type);
  if (exact) return exact;
  for (const [p, k, how] of TF_PATTERNS) if (how === "prefix" ? type.startsWith(p) : type.endsWith(p)) return k;
  return "generic";
}

/** An asset kind (not a group). */
export const isAssetKind = (k: TopoKind): k is TopoAssetKind => !(TOPO_GROUP_KINDS as readonly string[]).includes(k);
