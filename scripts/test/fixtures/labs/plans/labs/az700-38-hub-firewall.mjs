// az700-38-hub-firewall.mjs
//
// Plain English: lab 38's first-deploy plan, written out from
// labs/az700-38-hub-firewall/terraform/main.tf with a real session's values
// at slot 31 (10.71.192.0/18): vnet-hub 10.71.192.0/20 (AzureFirewallSubnet
// 10.71.192.0/26, AzureFirewallManagementSubnet 10.71.192.64/26),
// vnet-spoke1 10.71.208.0/20 (snet-workload 10.71.208.0/24) and vnet-spoke2
// 10.71.224.0/20 (snet-workload 10.71.224.0/24).
//
// The rules' addresses are known (locals of the slot); the firewall's
// private IP is not, so each spoke route's next hop is unknown and lists
// every step of azurerm_firewall.hub.ip_configuration[0].private_ip_address
// among its references, as Terraform 1.14 does.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

/** References to `address.a[0].b` as Terraform 1.14 lists them: the whole traversal, each shorter prefix, then the resource. */
const deepRef = (address, path) => {
  const steps = path.match(/\.?[a-z_]+|\[\d+\]/g).map((s) => (s.startsWith("[") || s.startsWith(".") ? s : `.${s}`));
  const out = [];
  for (let n = steps.length; n > 0; n--) out.push(`${address}${steps.slice(0, n).join("")}`);
  return [...out, address];
};

const SPOKE1 = "10.71.208.0/20";
const SPOKE2 = "10.71.224.0/20";
const SPOKES = [SPOKE1, SPOKE2];
const SPOKE_REFS = ["local.spoke1_cidr", "local.spoke2_cidr"];

export default () => {
  const c = ctx("az700-38-hub-firewall", "38", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, name, vnetKey, cidr, local, outbound) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: outbound },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${local}`] },
  });
  const peering = (from, to) => ({
    address: `azurerm_virtual_network_peering.${from}_to_${to}`,
    values: { name: `peer-${from}-to-${to}`, resource_group_name: c.rg, virtual_network_name: `vnet-${from}`, allow_virtual_network_access: true, allow_forwarded_traffic: true },
    unknown: ["remote_virtual_network_id"],
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${from}`, "name"), remote_virtual_network_id: ref(`azurerm_virtual_network.${to}`, "id") },
  });
  const pip = (key, name) => ({ address: `azurerm_public_ip.${key}`, values: { name, resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", tags: c.tags }, refs: IN_RG });
  const firewallIp = deepRef("azurerm_firewall.hub", "ip_configuration[0].private_ip_address");
  const table = (key) => ({ address: `azurerm_route_table.${key}`, values: { name: `rt-${key}`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG });
  const route = (key, table, name, prefix, prefixRef) => ({
    address: `azurerm_route.${key}`,
    values: { name, resource_group_name: c.rg, route_table_name: `rt-${table}`, address_prefix: prefix, next_hop_type: "VirtualAppliance" },
    unknown: ["next_hop_in_ip_address"],
    refs: { ...inRg, route_table_name: ref(`azurerm_route_table.${table}`, "name"), ...(prefixRef ? { address_prefix: [prefixRef] } : {}), next_hop_in_ip_address: firewallIp },
  });
  const association = (key) => ({
    address: `azurerm_subnet_route_table_association.${key}`,
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), route_table_id: ref(`azurerm_route_table.${key}`, "id") },
  });
  const webProtocols = [
    { type: "Http", port: 80 },
    { type: "Https", port: 443 },
  ];
  const web = "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)";
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      vnet("spoke1", SPOKE1),
      vnet("spoke2", SPOKE2),
      subnet("firewall", "AzureFirewallSubnet", "hub", "10.71.192.0/26", "firewall_cidr", true),
      subnet("firewall_management", "AzureFirewallManagementSubnet", "hub", "10.71.192.64/26", "firewall_management_cidr", true),
      subnet("spoke1", "snet-workload", "spoke1", "10.71.208.0/24", "spoke1_subnet", false),
      subnet("spoke2", "snet-workload", "spoke2", "10.71.224.0/24", "spoke2_subnet", false),
      peering("hub", "spoke1"),
      peering("spoke1", "hub"),
      peering("hub", "spoke2"),
      peering("spoke2", "hub"),

      // Firewall Manager policies: fwp-base (parent) and fwp-hub (child), and their rules.
      { address: "azurerm_firewall_policy.base", values: { name: "fwp-base", resource_group_name: c.rg, location: REGION, sku: "Basic", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_firewall_policy.hub",
        values: { name: "fwp-hub", resource_group_name: c.rg, location: REGION, sku: "Basic", tags: c.tags },
        unknown: ["base_policy_id"],
        refs: { ...IN_RG, base_policy_id: ref("azurerm_firewall_policy.base", "id") },
      },
      {
        address: "azurerm_firewall_policy_rule_collection_group.base",
        values: {
          name: "rcg-base",
          priority: 100,
          network_rule_collection: [
            {
              name: "allow-spoke-to-spoke",
              priority: 100,
              action: "Allow",
              rule: [
                { name: "ssh", protocols: ["TCP"], source_addresses: SPOKES, destination_addresses: SPOKES, destination_ports: ["22"] },
                { name: "ping", protocols: ["ICMP"], source_addresses: SPOKES, destination_addresses: SPOKES, destination_ports: ["*"] },
              ],
            },
          ],
        },
        unknown: ["firewall_policy_id"],
        refs: {
          firewall_policy_id: ref("azurerm_firewall_policy.base", "id"),
          "network_rule_collection.0.rule.0.source_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.0.destination_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.1.source_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.1.destination_addresses": SPOKE_REFS,
        },
      },
      {
        address: "azurerm_firewall_policy_rule_collection_group.hub",
        values: {
          name: "rcg-hub",
          priority: 200,
          application_rule_collection: [
            {
              name: "allow-web",
              priority: 200,
              action: "Allow",
              rule: [
                { name: "ubuntu-mirrors", source_addresses: SPOKES, destination_fqdns: ["*.ubuntu.com"], protocols: webProtocols },
                { name: "microsoft", source_addresses: SPOKES, destination_fqdns: ["www.microsoft.com"], protocols: webProtocols },
              ],
            },
          ],
        },
        unknown: ["firewall_policy_id"],
        refs: {
          firewall_policy_id: ref("azurerm_firewall_policy.hub", "id"),
          "application_rule_collection.0.rule.0.source_addresses": SPOKE_REFS,
          "application_rule_collection.0.rule.1.source_addresses": SPOKE_REFS,
        },
      },

      // The firewall, Basic, with its data and management public IPs.
      pip("firewall", "pip-afw-hub"),
      pip("firewall_management", "pip-afw-hub-mgmt"),
      {
        address: "azurerm_firewall.hub",
        values: { name: "afw-hub", resource_group_name: c.rg, location: REGION, sku_name: "AZFW_VNet", sku_tier: "Basic", tags: c.tags, ip_configuration: [{ name: "ipconfig-data" }], management_ip_configuration: [{ name: "ipconfig-mgmt" }] },
        unknown: ["firewall_policy_id", "ip_configuration.0.subnet_id", "ip_configuration.0.public_ip_address_id", "management_ip_configuration.0.subnet_id", "management_ip_configuration.0.public_ip_address_id"],
        refs: {
          ...IN_RG,
          firewall_policy_id: ref("azurerm_firewall_policy.hub", "id"),
          "ip_configuration.0.subnet_id": ref("azurerm_subnet.firewall", "id"),
          "ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.firewall", "id"),
          "management_ip_configuration.0.subnet_id": ref("azurerm_subnet.firewall_management", "id"),
          "management_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.firewall_management", "id"),
        },
      },

      // Each spoke's routes to the firewall.
      table("spoke1"),
      route("spoke1_default", "spoke1", "default-via-firewall", "0.0.0.0/0", null),
      route("spoke1_to_spoke2", "spoke1", "to-spoke2-via-firewall", SPOKE2, "local.spoke2_cidr"),
      association("spoke1"),
      table("spoke2"),
      route("spoke2_default", "spoke2", "default-via-firewall", "0.0.0.0/0", null),
      route("spoke2_to_spoke1", "spoke2", "to-spoke1-via-firewall", SPOKE1, "local.spoke1_cidr"),
      association("spoke2"),

      // Logs: a capped workspace and the firewall's diagnostic setting.
      {
        address: "azurerm_log_analytics_workspace.lab",
        values: { name: "log-hub", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_monitor_diagnostic_setting.firewall",
        values: {
          name: "diag-afw-hub",
          log_analytics_destination_type: "Dedicated",
          enabled_log: ["AZFWApplicationRule", "AZFWNetworkRule", "AZFWNatRule", "AZFWThreatIntel"].map((category) => ({ category })),
        },
        unknown: ["target_resource_id", "log_analytics_workspace_id"],
        refs: { target_resource_id: ref("azurerm_firewall.hub", "id"), log_analytics_workspace_id: ref("azurerm_log_analytics_workspace.lab", "id") },
      },

      // A VM in each spoke.
      ...linuxVm(c, { name: "vm-spoke1", key: "spoke1", subnet: "azurerm_subnet.spoke1", customData: web }),
      ...linuxVm(c, { name: "vm-spoke2", key: "spoke2", subnet: "azurerm_subnet.spoke2", customData: web }),
    ],
  };
};
