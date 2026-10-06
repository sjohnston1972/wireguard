// az700-34-route-server.mjs
//
// Plain English: lab 34's first-deploy plan, written out from
// labs/az700-34-route-server/terraform/main.tf with a real session's values
// at slot 31 (vnet-hub 10.71.192.0/20 with RouteServerSubnet 10.71.192.0/26
// and snet-nva 10.71.193.0/24, vm-nva at 10.71.193.4; vnet-spoke
// 10.71.208.0/20; the advertised prefix 10.71.240.0/24, in no VNet). The
// Route Server's public IP and subnet ids are unknown at plan, and so are
// its two instance addresses, which vm-nva's cloud-init is built from.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

const ROUTE_SERVER = "azurerm_route_server.rs";

export default () => {
  const c = ctx("az700-34-route-server", "34", { slot: 31 });
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
  const peering = (from, to, more) => ({
    address: `azurerm_virtual_network_peering.${from}_to_${to}`,
    values: { name: `peer-${from}-to-${to}`, resource_group_name: c.rg, virtual_network_name: `vnet-${from}`, allow_virtual_network_access: true, allow_forwarded_traffic: true, ...more },
    unknown: ["remote_virtual_network_id"],
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${from}`, "name"), remote_virtual_network_id: ref(`azurerm_virtual_network.${to}`, "id") },
  });

  // vm-nva: a fixed address, IP forwarding, and FRR's neighbours from the Route Server's addresses (unknown at plan).
  const [nvaNic, nvaVm] = linuxVm(c, {
    name: "vm-nva",
    subnet: "azurerm_subnet.nva",
    customData: ["local.nva_ip", `${ROUTE_SERVER}.virtual_router_ips`, ROUTE_SERVER, "local.advertised_prefix", "local.advertised_ip"],
  });
  nvaNic.values.ip_forwarding_enabled = true;
  Object.assign(nvaNic.values.ip_configuration[0], { private_ip_address_allocation: "Static", private_ip_address: "10.71.193.4" });
  nvaNic.refs["ip_configuration.0.private_ip_address"] = ["local.nva_ip"];

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      subnet("rs", "hub", "RouteServerSubnet", "10.71.192.0/26"),
      subnet("nva", "hub", "snet-nva", "10.71.193.0/24"),
      { address: "azurerm_public_ip.rs", values: { name: "pip-rs", resource_group_name: c.rg, location: REGION, sku: "Standard", allocation_method: "Static", zones: ["1", "2", "3"], tags: c.tags }, refs: IN_RG },
      {
        address: ROUTE_SERVER,
        values: { name: "rs-hub", resource_group_name: c.rg, location: REGION, sku: "Standard", branch_to_branch_traffic_enabled: false, tags: c.tags },
        unknown: ["public_ip_address_id", "subnet_id"],
        refs: { ...IN_RG, public_ip_address_id: ref("azurerm_public_ip.rs", "id"), subnet_id: ref("azurerm_subnet.rs", "id") },
      },
      {
        address: "azurerm_route_server_bgp_connection.nva",
        values: { name: "bgp-nva", peer_asn: 65010, peer_ip: "10.71.193.4" },
        unknown: ["route_server_id"],
        refs: { route_server_id: ref(ROUTE_SERVER, "id"), peer_ip: ["local.nva_ip"] },
      },
      nvaNic,
      nvaVm,
      vnet("spoke", "10.71.208.0/20"),
      subnet("app", "spoke", "snet-app", "10.71.208.0/24"),
      peering("hub", "spoke", { allow_gateway_transit: true }),
      peering("spoke", "hub", { use_remote_gateways: true }),
      ...linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.app", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
    ],
  };
};
