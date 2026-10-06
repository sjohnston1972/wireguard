// az700-36-s2s-vpn.mjs
//
// Plain English: lab 36's first-deploy plan, written out from
// labs/az700-36-s2s-vpn/terraform/main.tf with a real session's values at
// slot 31 (10.71.192.0/18): vnet-azure 10.71.192.0/20 (GatewaySubnet
// 10.71.192.0/27, snet-app 10.71.193.0/24) and vnet-onprem 10.71.208.0/20
// (GatewaySubnet 10.71.208.0/27, snet-onprem 10.71.209.0/24).
//
// What a plan cannot know yet: the public IPs' addresses (each local network
// gateway's gateway_address), every id, and each gateway's BGP peering
// addresses (bgp_settings.0.peering_addresses, which the provider computes;
// the local network gateways read them through
// bgp_settings[0].peering_addresses[0].default_addresses[0], which Terraform
// lists as every step of that traversal, as the real plans recorded
// identity[0].principal_id). The shared key comes from random_password.psk:
// sensitive in the plan, as the schema marks shared_key.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

/** References to `address.a[0].b[0].c` as Terraform 1.14 lists them: the whole traversal, each shorter prefix, then the resource. */
const deepRef = (address, path) => {
  const steps = path.match(/\.?[a-z_]+|\[\d+\]/g);
  const out = [];
  for (let n = steps.length; n > 0; n--) out.push(`${address}${steps.slice(0, n).map((s) => (s.startsWith("[") || s.startsWith(".") ? s : `.${s}`)).join("")}`);
  return [...out, address];
};

export default () => {
  const c = ctx("az700-36-s2s-vpn", "36", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, name, vnetKey, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: true },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const pip = (side) => ({
    address: `azurerm_public_ip.${side}_gateway`,
    values: { name: `pip-vpngw-${side}`, resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", zones: ["1", "2", "3"], tags: c.tags },
    refs: IN_RG,
  });
  const gateway = (side, asn) => ({
    address: `azurerm_virtual_network_gateway.${side}`,
    values: {
      name: `vpngw-${side}`,
      resource_group_name: c.rg,
      location: REGION,
      type: "Vpn",
      vpn_type: "RouteBased",
      sku: "VpnGw1AZ",
      generation: "Generation1",
      active_active: false,
      bgp_enabled: true,
      tags: c.tags,
      bgp_settings: [{ asn }],
      ip_configuration: [{ name: "gwipconfig", private_ip_address_allocation: "Dynamic" }],
    },
    // The gateway's BGP peering addresses are the provider's to fill in (the block is optional and computed).
    unknown: ["bgp_settings.0.peering_addresses", "ip_configuration.0.public_ip_address_id", "ip_configuration.0.subnet_id"],
    refs: {
      ...IN_RG,
      "ip_configuration.0.public_ip_address_id": ref(`azurerm_public_ip.${side}_gateway`, "id"),
      "ip_configuration.0.subnet_id": ref(`azurerm_subnet.${side}_gateway`, "id"),
    },
  });
  // lgw-<far> describes the far side, for the near side's gateway.
  const localGateway = (far, cidr, asn) => ({
    address: `azurerm_local_network_gateway.${far}`,
    values: { name: `lgw-${far}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags, bgp_settings: [{ asn }] },
    unknown: ["gateway_address", "bgp_settings.0.bgp_peering_address"],
    refs: {
      ...IN_RG,
      address_space: [`local.${far}_cidr`],
      gateway_address: ref(`azurerm_public_ip.${far}_gateway`, "ip_address"),
      "bgp_settings.0.bgp_peering_address": deepRef(`azurerm_virtual_network_gateway.${far}`, "bgp_settings[0].peering_addresses[0].default_addresses[0]"),
    },
  });
  const connection = (near, far) => ({
    address: `azurerm_virtual_network_gateway_connection.${near}_to_${far}`,
    values: {
      name: `cn-${near}-to-${far}`,
      resource_group_name: c.rg,
      location: REGION,
      type: "IPsec",
      bgp_enabled: true,
      tags: c.tags,
      ipsec_policy: [{ dh_group: "DHGroup14", ike_encryption: "AES256", ike_integrity: "SHA256", ipsec_encryption: "GCMAES256", ipsec_integrity: "GCMAES256", pfs_group: "PFS14", sa_lifetime: 27000 }],
    },
    unknown: ["virtual_network_gateway_id", "local_network_gateway_id", "shared_key"],
    refs: {
      ...IN_RG,
      virtual_network_gateway_id: ref(`azurerm_virtual_network_gateway.${near}`, "id"),
      local_network_gateway_id: ref(`azurerm_local_network_gateway.${far}`, "id"),
      shared_key: ref("random_password.psk", "result"),
    },
  });
  const web = "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)";
  return {
    lab: c.id,
    providers: ["azurerm", "random"],
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("azure", "10.71.192.0/20"),
      vnet("onprem", "10.71.208.0/20"),
      subnet("azure_gateway", "GatewaySubnet", "azure", "10.71.192.0/27"),
      subnet("onprem_gateway", "GatewaySubnet", "onprem", "10.71.208.0/27"),
      subnet("azure_app", "snet-app", "azure", "10.71.193.0/24"),
      subnet("onprem_app", "snet-onprem", "onprem", "10.71.209.0/24"),

      // The gateways and their zone-redundant Standard public IPs.
      pip("azure"),
      pip("onprem"),
      gateway("azure", 65010),
      gateway("onprem", 65020),

      // Each local network gateway describes the other side.
      localGateway("onprem", "10.71.208.0/20", 65020),
      localGateway("azure", "10.71.192.0/20", 65010),

      // The tunnel: the shared key, and one connection from each end.
      { address: "random_password.psk", values: { length: 32, special: false }, sensitive: ["bcrypt_hash", "result"] },
      connection("azure", "onprem"),
      connection("onprem", "azure"),

      // A VM on each side.
      ...linuxVm(c, { name: "vm-azure", key: "azure", subnet: "azurerm_subnet.azure_app", customData: web }),
      ...linuxVm(c, { name: "vm-onprem", key: "onprem", subnet: "azurerm_subnet.onprem_app", customData: web }),
    ],
  };
};
