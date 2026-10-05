// az104-14-peering-udr.mjs
//
// Plain English: lab 14's first-deploy plan, written out from
// labs/az104-14-peering-udr/terraform/main.tf with a real session's values
// (slot 1: vnet-hub 10.64.64.0/20, vnet-spoke1 10.64.80.0/20, vnet-spoke2
// 10.64.96.0/20; the router's static address 10.64.64.4). The routes are
// known at plan (prefixes and the router's address come from the slot);
// peerings and associations need ids, so those are unknown.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-14-peering-udr", "14");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, vnetKey, name, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr] },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const peering = (from, to) => ({
    address: `azurerm_virtual_network_peering.${from}_to_${to}`,
    values: { name: `peer-${from}-to-${to}`, resource_group_name: c.rg, virtual_network_name: `vnet-${from}`, allow_virtual_network_access: true, allow_forwarded_traffic: true },
    unknown: ["remote_virtual_network_id"],
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${from}`, "name"), remote_virtual_network_id: ref(`azurerm_virtual_network.${to}`, "id") },
  });
  const table = (key) => ({ address: `azurerm_route_table.${key}`, values: { name: `rt-${key}`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG });
  const route = (from, to, cidr) => ({
    address: `azurerm_route.${from}_to_${to}`,
    values: { name: `to-${to}-via-router`, resource_group_name: c.rg, route_table_name: `rt-${from}`, address_prefix: cidr, next_hop_type: "VirtualAppliance", next_hop_in_ip_address: "10.64.64.4" },
    refs: { ...inRg, route_table_name: ref(`azurerm_route_table.${from}`, "name"), address_prefix: [`local.${to}_cidr`], next_hop_in_ip_address: ["local.router_ip"] },
  });
  const assoc = (key) => ({
    address: `azurerm_subnet_route_table_association.${key}`,
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), route_table_id: ref(`azurerm_route_table.${key}`, "id") },
  });

  // The router: a static address and IP forwarding on its NIC; sysctl in its cloud-init.
  const [routerNic, routerVm] = linuxVm(c, { name: "vm-router", subnet: "azurerm_subnet.router", customData: "I2Nsb3VkLWNvbmZpZwo= (router-init.yaml.tftpl)" });
  routerNic.values.ip_forwarding_enabled = true;
  Object.assign(routerNic.values.ip_configuration[0], { private_ip_address_allocation: "Static", private_ip_address: "10.64.64.4" });
  routerNic.refs["ip_configuration.0.private_ip_address"] = ["local.router_ip"];

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.64.64.0/20"),
      vnet("spoke1", "10.64.80.0/20"),
      vnet("spoke2", "10.64.96.0/20"),
      subnet("router", "hub", "snet-router", "10.64.64.0/24"),
      subnet("spoke1", "spoke1", "snet-workload", "10.64.80.0/24"),
      subnet("spoke2", "spoke2", "snet-workload", "10.64.96.0/24"),
      peering("hub", "spoke1"),
      peering("spoke1", "hub"),
      peering("hub", "spoke2"),
      peering("spoke2", "hub"),
      routerNic,
      routerVm,
      table("spoke1"),
      table("spoke2"),
      route("spoke1", "spoke2", "10.64.96.0/20"),
      route("spoke2", "spoke1", "10.64.80.0/20"),
      assoc("spoke1"),
      assoc("spoke2"),
      ...linuxVm(c, { name: "vm-spoke1", subnet: "azurerm_subnet.spoke1", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
      ...linuxVm(c, { name: "vm-spoke2", subnet: "azurerm_subnet.spoke2", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
    ],
  };
};
