// az104-13-vnets.mjs
//
// Plain English: lab 13's first-deploy plan, written out from
// labs/az104-13-vnets/terraform/main.tf with a real session's values (slot 1,
// so the VNet is 10.64.64.0/20, snet-web 10.64.64.0/24 and snet-app
// 10.64.65.0/24). Ids are unknown at plan, so every association and every
// rule that names an ASG is too. The VMs' cloud-init is rendered from known
// values (a port), so it is known.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-13-vnets", "13");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const subnet = (key, cidr, local) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: [cidr] },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: [local] },
  });
  const named = (type, key, name) => ({ address: `${type}.${key}`, values: { name, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG });
  // A rule from an address prefix (a service tag here).
  const rule = (key, nsg, v) => ({
    address: `azurerm_network_security_rule.${key}`,
    values: { resource_group_name: c.rg, network_security_group_name: `nsg-${nsg}`, direction: "Inbound", source_port_range: "*", destination_address_prefix: "*", ...v },
    refs: { ...inRg, network_security_group_name: ref(`azurerm_network_security_group.${nsg}`, "name") },
  });
  const assoc = (key) => ({
    address: `azurerm_subnet_network_security_group_association.${key}`,
    values: {},
    unknown: ["subnet_id", "network_security_group_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), network_security_group_id: ref(`azurerm_network_security_group.${key}`, "id") },
  });
  const member = (key) => ({
    address: `azurerm_network_interface_application_security_group_association.${key}`,
    values: {},
    unknown: ["network_interface_id", "application_security_group_id"],
    refs: { network_interface_id: ref(`azurerm_network_interface.${key}`, "id"), application_security_group_id: ref(`azurerm_application_security_group.${key}`, "id") },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      subnet("web", "10.64.64.0/24", "local.web_cidr"),
      subnet("app", "10.64.65.0/24", "local.app_cidr"),
      named("azurerm_application_security_group", "web", "asg-web"),
      named("azurerm_application_security_group", "app", "asg-app"),
      named("azurerm_network_security_group", "web", "nsg-web"),
      named("azurerm_network_security_group", "app", "nsg-app"),
      rule("web_ssh", "web", { name: "allow-ssh-from-vnet", priority: 100, access: "Allow", protocol: "Tcp", destination_port_range: "22", source_address_prefix: "VirtualNetwork" }),
      rule("web_http", "web", { name: "allow-http-from-vnet", priority: 110, access: "Allow", protocol: "Tcp", destination_port_range: "80", source_address_prefix: "VirtualNetwork" }),
      rule("web_deny_vnet", "web", { name: "deny-other-vnet", priority: 4000, access: "Deny", protocol: "*", destination_port_range: "*", source_address_prefix: "VirtualNetwork" }),
      {
        address: "azurerm_network_security_rule.app_from_web",
        values: { name: "allow-asg-web-to-asg-app-8080", resource_group_name: c.rg, network_security_group_name: "nsg-app", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", source_port_range: "*", destination_port_range: "8080" },
        unknown: ["source_application_security_group_ids", "destination_application_security_group_ids"],
        refs: {
          ...inRg,
          network_security_group_name: ref("azurerm_network_security_group.app", "name"),
          source_application_security_group_ids: ref("azurerm_application_security_group.web", "id"),
          destination_application_security_group_ids: ref("azurerm_application_security_group.app", "id"),
        },
      },
      rule("app_deny_vnet", "app", { name: "deny-other-vnet", priority: 4000, access: "Deny", protocol: "*", destination_port_range: "*", source_address_prefix: "VirtualNetwork" }),
      assoc("web"),
      assoc("app"),
      ...linuxVm(c, { name: "vm-web", subnet: "azurerm_subnet.web", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
      ...linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.app", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 8080)" }),
      member("web"),
      member("app"),
    ],
  };
};
