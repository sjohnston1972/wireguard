// az700-33-vnet-manager.mjs
//
// Plain English: lab 33's first-deploy plan, written out from
// labs/az700-33-vnet-manager/terraform/main.tf with a real session's values
// at slot 31 (vnet-hub 10.71.192.0/20, vnet-spoke1 10.71.208.0/20,
// vnet-spoke2 10.71.224.0/20, a /24 subnet in each). The network manager's
// scope is the subscription the data source read at plan (scope exception
// S1); every AVNM id that joins the rest (group, members, configurations,
// rule collection, deployments) is a reference to the lab's own resource,
// known only after apply.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, SUB, TENANT } from "../common.mjs";

const IDS = (address) => ref(address, "id");
const AVNM = "azurerm_network_manager.avnm";
const GROUP = "azurerm_network_manager_network_group.spokes";
const SAC = "azurerm_network_manager_security_admin_configuration.lab";
const COLLECTION = "azurerm_network_manager_admin_rule_collection.spokes";
const WEB = "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)";

export default () => {
  const c = ctx("az700-33-vnet-manager", "33", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, vnetKey, name, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: true },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const nsg = (key) => [
    { address: `azurerm_network_security_group.${key}`, values: { name: `nsg-${key}`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
    {
      address: `azurerm_network_security_rule.${key}_deny_hub_ssh`,
      values: { name: "deny-ssh-from-hub", resource_group_name: c.rg, network_security_group_name: `nsg-${key}`, priority: 100, direction: "Inbound", access: "Deny", protocol: "Tcp", source_address_prefix: "10.71.192.0/20", source_port_range: "*", destination_address_prefix: "*", destination_port_range: "22" },
      refs: { ...inRg, network_security_group_name: ref(`azurerm_network_security_group.${key}`, "name"), source_address_prefix: ["local.hub_cidr"] },
    },
    {
      address: `azurerm_subnet_network_security_group_association.${key}`,
      values: {},
      unknown: ["subnet_id", "network_security_group_id"],
      refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), network_security_group_id: ref(`azurerm_network_security_group.${key}`, "id") },
    },
  ];
  const member = (key) => ({
    address: `azurerm_network_manager_static_member.${key}`,
    values: { name: `sm-${key}` },
    unknown: ["network_group_id", "target_virtual_network_id"],
    refs: { network_group_id: IDS(GROUP), target_virtual_network_id: IDS(`azurerm_virtual_network.${key}`) },
  });
  const rule = (key, values, source, sourceRefs = {}) => ({
    address: `azurerm_network_manager_admin_rule.${key}`,
    values: { ...values, direction: "Inbound", protocol: "Tcp", destination_port_ranges: ["22"], source: [source] },
    unknown: ["admin_rule_collection_id"],
    refs: { admin_rule_collection_id: IDS(COLLECTION), ...sourceRefs },
  });
  const deployment = (key, access, config) => ({
    address: `azurerm_network_manager_deployment.${key}`,
    // timeouts as `terraform show -json` prints the block: every operation, unset ones null.
    values: { location: REGION, scope_access: access, timeouts: { create: "30m", delete: "30m", read: null, update: null } },
    unknown: ["network_manager_id", "configuration_ids"],
    refs: { network_manager_id: IDS(AVNM), location: IN_RG.location, configuration_ids: IDS(config) },
  });

  return {
    lab: c.id,
    variables: c.variables,
    data: [{ address: "data.azurerm_subscription.current", values: { id: `/subscriptions/${SUB}`, subscription_id: SUB, display_name: "Pay-As-You-Go", tenant_id: TENANT } }],
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      subnet("shared", "hub", "snet-shared", "10.71.192.0/24"),
      vnet("spoke1", "10.71.208.0/20"),
      subnet("spoke1", "spoke1", "snet-app", "10.71.208.0/24"),
      vnet("spoke2", "10.71.224.0/20"),
      subnet("spoke2", "spoke2", "snet-app", "10.71.224.0/24"),
      ...nsg("spoke1"),
      ...nsg("spoke2"),
      {
        address: AVNM,
        values: { name: "avnm-l33k3x9q", resource_group_name: c.rg, location: REGION, scope_accesses: ["Connectivity", "SecurityAdmin"], description: "Lab 33: manages only this lab's spokes (static members).", tags: c.tags, scope: [{ subscription_ids: [`/subscriptions/${SUB}`] }] },
        refs: { ...IN_RG, name: ["var.name_prefix"], "scope.0.subscription_ids": IDS("data.azurerm_subscription.current") },
      },
      { address: GROUP, values: { name: "ng-spokes", description: "The lab's two spokes." }, unknown: ["network_manager_id"], refs: { network_manager_id: IDS(AVNM) } },
      member("spoke1"),
      member("spoke2"),
      {
        address: "azurerm_network_manager_connectivity_configuration.hub_spoke",
        values: { name: "cc-hub-spoke", connectivity_topology: "HubAndSpoke", global_mesh_enabled: false, delete_existing_peering_enabled: false, applies_to_group: [{ group_connectivity: "DirectlyConnected", use_hub_gateway: false }], hub: [{ resource_type: "Microsoft.Network/virtualNetworks" }] },
        unknown: ["network_manager_id", "applies_to_group.0.network_group_id", "hub.0.resource_id"],
        refs: { network_manager_id: IDS(AVNM), "applies_to_group.0.network_group_id": IDS(GROUP), "hub.0.resource_id": IDS("azurerm_virtual_network.hub") },
      },
      { address: SAC, values: { name: "sac-lab" }, unknown: ["network_manager_id"], refs: { network_manager_id: IDS(AVNM) } },
      {
        address: COLLECTION,
        values: { name: "rc-spokes" },
        unknown: ["security_admin_configuration_id", "network_group_ids"],
        refs: { security_admin_configuration_id: IDS(SAC), network_group_ids: IDS(GROUP) },
      },
      rule("deny_ssh", { name: "deny-ssh-internet", action: "Deny", priority: 100 }, { address_prefix_type: "ServiceTag", address_prefix: "Internet" }),
      rule("allow_hub_ssh", { name: "always-allow-hub-ssh", action: "AlwaysAllow", priority: 90 }, { address_prefix_type: "IPPrefix", address_prefix: "10.71.192.0/20" }, { "source.0.address_prefix": ["local.hub_cidr"] }),
      deployment("connectivity", "Connectivity", "azurerm_network_manager_connectivity_configuration.hub_spoke"),
      deployment("security", "SecurityAdmin", SAC),
      ...linuxVm(c, { name: "vm-spoke1", subnet: "azurerm_subnet.spoke1", customData: WEB }),
      ...linuxVm(c, { name: "vm-spoke2", subnet: "azurerm_subnet.spoke2", customData: WEB }),
    ],
  };
};
