// suite/az700-95-addresses/plan.mjs
//
// Plain English: the fixture lab's first-deploy plan, at slot 31
// (10.71.192.0/18) as the AZ-700 plan fixtures use: vnet-hub is the slot's
// /20 0, vnet-onprem its /20 1, and the gateway's P2S client pool the last
// /24 of /20 3, outside both VNets.

import { ctx, IN_RG, ref, REGION, rgResource } from "../../plans/common.mjs";

export default () => {
  const c = ctx("az700-95-addresses", "95", { slot: 31 });
  const vnet = (key, cidr) => ({ address: `azurerm_virtual_network.${key}`, values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags }, refs: { ...IN_RG, address_space: ["var.address_space"] } });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      { address: "azurerm_subnet.gateway", values: { name: "GatewaySubnet", resource_group_name: c.rg, virtual_network_name: "vnet-hub", address_prefixes: ["10.71.192.0/27"], default_outbound_access_enabled: false }, refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.hub", "name"), address_prefixes: ["var.address_space"] } },
      vnet("onprem", "10.71.208.0/20"),
      { address: "azurerm_public_ip.gw", values: { name: "pip-gw", resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", zones: ["1", "2", "3"], tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_virtual_network_gateway.gw",
        values: {
          name: "vgw-hub",
          resource_group_name: c.rg,
          location: REGION,
          type: "Vpn",
          vpn_type: "RouteBased",
          sku: "VpnGw1AZ",
          generation: "Generation1",
          tags: c.tags,
          ip_configuration: [{ name: "gw" }],
          vpn_client_configuration: [{ address_space: ["10.71.255.0/24"], vpn_client_protocols: ["OpenVPN"] }],
        },
        unknown: ["ip_configuration.0.public_ip_address_id", "ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, "ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.gw", "id"), "ip_configuration.0.subnet_id": ref("azurerm_subnet.gateway", "id"), "vpn_client_configuration.0.address_space": ["var.address_space"] },
      },
    ],
  };
};
