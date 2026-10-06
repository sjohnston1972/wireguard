// az700-32-dns-resolver.mjs
//
// Plain English: lab 32's first-deploy plan, written out from
// labs/az700-32-dns-resolver/terraform/main.tf with a real session's values
// at slot 31 (vnet-hub 10.71.192.0/20 with snet-app 10.71.192.0/24, snet-in
// 10.71.193.0/28 and snet-out 10.71.193.16/28; vnet-onprem 10.71.208.0/20
// with snet-onprem 10.71.208.0/24 and vm-dns at 10.71.208.4). Addresses are
// known at plan; the resolver's ids are not, and nor is the inbound
// endpoint's dynamic address, so vm-dns's cloud-init is unknown at plan too.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

const INBOUND = "azurerm_private_dns_resolver_inbound_endpoint.in";
const RULESET = "azurerm_private_dns_resolver_dns_forwarding_ruleset.onprem";
const DELEGATION = [{ name: "dnsresolvers", service_delegation: [{ name: "Microsoft.Network/dnsResolvers", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] }] }];

export default () => {
  const c = ctx("az700-32-dns-resolver", "32", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr, more = {}, moreRefs = {}) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags, ...more },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`], ...moreRefs },
  });
  const subnet = (key, vnetKey, cidr, more = {}) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: true, ...more },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const peering = (from, to) => ({
    address: `azurerm_virtual_network_peering.${from}_to_${to}`,
    values: { name: `peer-${from}-to-${to}`, resource_group_name: c.rg, virtual_network_name: `vnet-${from}`, allow_virtual_network_access: true },
    unknown: ["remote_virtual_network_id"],
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${from}`, "name"), remote_virtual_network_id: ref(`azurerm_virtual_network.${to}`, "id") },
  });

  // vm-dns: a fixed address, Azure DNS on its own NIC, and a cloud-init built from the inbound endpoint's address.
  const inboundIp = `${INBOUND}.ip_configurations[0].private_ip_address`;
  const [dnsNic, dnsVm] = linuxVm(c, {
    name: "vm-dns",
    subnet: "azurerm_subnet.onprem",
    // Terraform lists every step of a traversal through a nested block, longest first.
    customData: ["local.dns_ip", inboundIp, `${INBOUND}.ip_configurations[0]`, `${INBOUND}.ip_configurations`, INBOUND],
  });
  dnsNic.values.dns_servers = ["168.63.129.16"];
  Object.assign(dnsNic.values.ip_configuration[0], { private_ip_address_allocation: "Static", private_ip_address: "10.71.208.4" });
  dnsNic.refs["ip_configuration.0.private_ip_address"] = ["local.dns_ip"];

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      vnet("hub", "10.71.192.0/20"),
      subnet("app", "hub", "10.71.192.0/24"),
      subnet("in", "hub", "10.71.193.0/28", { delegation: DELEGATION }),
      subnet("out", "hub", "10.71.193.16/28", { delegation: DELEGATION }),
      vnet("onprem", "10.71.208.0/20", { dns_servers: ["10.71.208.4"] }, { dns_servers: ["local.dns_ip"] }),
      subnet("onprem", "onprem", "10.71.208.0/24"),
      peering("hub", "onprem"),
      peering("onprem", "hub"),
      {
        address: "azurerm_private_dns_resolver.hub",
        values: { name: "dnspr-hub", resource_group_name: c.rg, location: REGION, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...IN_RG, virtual_network_id: ref("azurerm_virtual_network.hub", "id") },
      },
      {
        address: INBOUND,
        values: { name: "in-hub", location: REGION, tags: c.tags, ip_configurations: [{ private_ip_allocation_method: "Dynamic" }] },
        unknown: ["private_dns_resolver_id", "ip_configurations.0.subnet_id"],
        refs: { private_dns_resolver_id: ref("azurerm_private_dns_resolver.hub", "id"), location: IN_RG.location, tags: ["var.tags"], "ip_configurations.0.subnet_id": ref("azurerm_subnet.in", "id") },
      },
      {
        address: "azurerm_private_dns_resolver_outbound_endpoint.out",
        values: { name: "out-hub", location: REGION, tags: c.tags },
        unknown: ["private_dns_resolver_id", "subnet_id"],
        refs: { private_dns_resolver_id: ref("azurerm_private_dns_resolver.hub", "id"), location: IN_RG.location, subnet_id: ref("azurerm_subnet.out", "id"), tags: ["var.tags"] },
      },
      {
        address: RULESET,
        values: { name: "frs-onprem", resource_group_name: c.rg, location: REGION, tags: c.tags },
        unknown: ["private_dns_resolver_outbound_endpoint_ids"],
        refs: { ...IN_RG, private_dns_resolver_outbound_endpoint_ids: ref("azurerm_private_dns_resolver_outbound_endpoint.out", "id") },
      },
      {
        address: "azurerm_private_dns_resolver_forwarding_rule.onprem",
        values: { name: "onprem-lab32", domain_name: "onprem.lab32.internal.", enabled: true, target_dns_servers: [{ ip_address: "10.71.208.4", port: 53 }] },
        unknown: ["dns_forwarding_ruleset_id"],
        refs: { dns_forwarding_ruleset_id: ref(RULESET, "id"), "target_dns_servers.0.ip_address": ["local.dns_ip"] },
      },
      {
        address: "azurerm_private_dns_resolver_virtual_network_link.hub",
        values: { name: "link-hub" },
        unknown: ["dns_forwarding_ruleset_id", "virtual_network_id"],
        refs: { dns_forwarding_ruleset_id: ref(RULESET, "id"), virtual_network_id: ref("azurerm_virtual_network.hub", "id") },
      },
      { address: "azurerm_private_dns_zone.azure", values: { name: "azure.lab32.internal", resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.hub",
        values: { name: "link-hub", resource_group_name: c.rg, private_dns_zone_name: "azure.lab32.internal", registration_enabled: true, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.azure", "name"), virtual_network_id: ref("azurerm_virtual_network.hub", "id"), tags: ["var.tags"] },
      },
      ...linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.app" }),
      dnsNic,
      dnsVm,
    ],
  };
};
