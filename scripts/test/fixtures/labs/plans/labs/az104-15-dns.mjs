// az104-15-dns.mjs
//
// Plain English: lab 15's first-deploy plan, written out from
// labs/az104-15-dns/terraform/main.tf with a real session's values (slot 1,
// prefix l15k3x9q). Zone and record names are known at plan; the zones'
// name servers, the link's VNet id and the VM's NIC are not.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-15-dns", "15");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const zone = `${c.prefix}.example.com`;
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.vms",
        values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"] },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.vms_cidr"] },
      },
      // Public: a zone under example.com, never delegated, with documentation addresses.
      { address: "azurerm_dns_zone.public", values: { name: zone, resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, name: ["var.name_prefix"], tags: ["var.tags"] } },
      {
        address: "azurerm_dns_a_record.www",
        values: { name: "www", zone_name: zone, resource_group_name: c.rg, ttl: 300, records: ["203.0.113.10"], tags: c.tags },
        refs: { ...inRg, zone_name: ref("azurerm_dns_zone.public", "name"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_dns_cname_record.app",
        values: { name: "app", zone_name: zone, resource_group_name: c.rg, ttl: 300, record: `www.${zone}`, tags: c.tags },
        refs: { ...inRg, zone_name: ref("azurerm_dns_zone.public", "name"), record: ref("azurerm_dns_zone.public", "name"), tags: ["var.tags"] },
      },
      // Private: lab15.internal, linked to the lab VNet with auto-registration.
      { address: "azurerm_private_dns_zone.internal", values: { name: "lab15.internal", resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.lab",
        values: { name: "link-vnet-lab", resource_group_name: c.rg, private_dns_zone_name: "lab15.internal", registration_enabled: true, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.internal", "name"), virtual_network_id: ref("azurerm_virtual_network.lab", "id"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_private_dns_a_record.www",
        values: { name: "www", zone_name: "lab15.internal", resource_group_name: c.rg, ttl: 300, tags: c.tags },
        unknown: ["records"],
        refs: { ...inRg, zone_name: ref("azurerm_private_dns_zone.internal", "name"), records: ref("azurerm_network_interface.web", "private_ip_address"), tags: ["var.tags"] },
      },
      ...linuxVm(c, { name: "vm-web", subnet: "azurerm_subnet.vms", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
    ],
  };
};
