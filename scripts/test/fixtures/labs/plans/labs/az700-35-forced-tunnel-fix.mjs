// az700-35-forced-tunnel-fix.mjs
//
// Plain English: lab 35's first-deploy plan, written out from
// labs/az700-35-forced-tunnel-fix/terraform/main.tf with a real session's
// values at slot 31 (vnet-hub 10.71.192.0/20 with snet-nva 10.71.192.0/24
// and vm-nva at 10.71.192.4; vnet-spoke 10.71.208.0/20 with snet-app
// 10.71.208.0/24). The default route is known at plan (the prefix is a
// literal, the next hop comes from the slot); peerings and associations
// need ids, so those are unknown.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az700-35-forced-tunnel-fix", "35", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, vnetKey, cidr, outbound) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: outbound },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const peering = (from, to) => ({
    address: `azurerm_virtual_network_peering.${from}_to_${to}`,
    values: { name: `peer-${from}-to-${to}`, resource_group_name: c.rg, virtual_network_name: `vnet-${from}`, allow_virtual_network_access: true, allow_forwarded_traffic: true },
    unknown: ["remote_virtual_network_id"],
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${from}`, "name"), remote_virtual_network_id: ref(`azurerm_virtual_network.${to}`, "id") },
  });

  // The appliance: a fixed address and IP forwarding OFF (fault 1); its cloud-init turns the kernel's off too (fault 2).
  const [nvaNic, nvaVm] = linuxVm(c, { name: "vm-nva", subnet: "azurerm_subnet.nva", customData: "I2Nsb3VkLWNvbmZpZwo= (nva-init.yaml.tftpl)" });
  nvaNic.values.ip_forwarding_enabled = false;
  Object.assign(nvaNic.values.ip_configuration[0], { private_ip_address_allocation: "Static", private_ip_address: "10.71.192.4" });
  nvaNic.refs["ip_configuration.0.private_ip_address"] = ["local.nva_ip"];

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      subnet("nva", "hub", "10.71.192.0/24", true),
      vnet("spoke", "10.71.208.0/20"),
      subnet("app", "spoke", "10.71.208.0/24", false),
      peering("hub", "spoke"),
      peering("spoke", "hub"),
      { address: "azurerm_route_table.spoke", values: { name: "rt-spoke", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_route.default",
        values: { name: "default-via-nva", resource_group_name: c.rg, route_table_name: "rt-spoke", address_prefix: "0.0.0.0/0", next_hop_type: "VirtualAppliance", next_hop_in_ip_address: "10.71.192.4" },
        refs: { ...inRg, route_table_name: ref("azurerm_route_table.spoke", "name"), next_hop_in_ip_address: ["local.nva_ip"] },
      },
      {
        address: "azurerm_subnet_route_table_association.app",
        values: {},
        unknown: ["subnet_id", "route_table_id"],
        refs: { subnet_id: ref("azurerm_subnet.app", "id"), route_table_id: ref("azurerm_route_table.spoke", "id") },
      },
      nvaNic,
      nvaVm,
      ...linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.app" }),
    ],
  };
};
