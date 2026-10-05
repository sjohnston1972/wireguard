// az104-17-netwatcher-fix.mjs
//
// Plain English: lab 17's first-deploy plan, written out from
// labs/az104-17-netwatcher-fix/terraform/main.tf with a real session's
// values (slot 1: snet-app 10.64.64.0/24, snet-db 10.64.65.0/24, and the
// address nothing holds, 10.64.79.4, in the VNet's last /24, which no
// subnet uses). No Network Watcher resource: Azure's own does the work.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-17-netwatcher-fix", "17");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const subnet = (key, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: [cidr] },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const rule = (key, v, refs = {}) => ({
    address: `azurerm_network_security_rule.${key}`,
    values: { resource_group_name: c.rg, network_security_group_name: "nsg-db", direction: "Inbound", protocol: "Tcp", source_port_range: "*", destination_address_prefix: "*", ...v },
    refs: { ...inRg, network_security_group_name: ref("azurerm_network_security_group.db", "name"), ...refs },
  });
  const agent = (key) => ({
    address: `azurerm_virtual_machine_extension.nw_${key}`,
    values: { name: "AzureNetworkWatcherExtension", publisher: "Microsoft.Azure.NetworkWatcher", type: "NetworkWatcherAgentLinux", type_handler_version: "1.4", auto_upgrade_minor_version: true, tags: c.tags },
    unknown: ["virtual_machine_id"],
    refs: { virtual_machine_id: ref(`azurerm_linux_virtual_machine.${key}`, "id"), tags: ["var.tags"] },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      subnet("app", "10.64.64.0/24"),
      subnet("db", "10.64.65.0/24"),

      // The db subnet's NSG: a deny named like an allow, ahead of the real allow.
      { address: "azurerm_network_security_group.db", values: { name: "nsg-db", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      rule("db_monitoring", { name: "allow-monitoring", priority: 100, access: "Deny", destination_port_range: "8080", source_address_prefix: "VirtualNetwork" }),
      rule("db_from_app", { name: "allow-app-8080", priority: 200, access: "Allow", destination_port_range: "8080", source_address_prefix: "10.64.64.0/24" }, { source_address_prefix: ["local.app_cidr"] }),
      rule("db_ssh", { name: "allow-ssh-from-vnet", priority: 300, access: "Allow", destination_port_range: "22", source_address_prefix: "VirtualNetwork" }),
      {
        address: "azurerm_subnet_network_security_group_association.db",
        values: {},
        unknown: ["subnet_id", "network_security_group_id"],
        refs: { subnet_id: ref("azurerm_subnet.db", "id"), network_security_group_id: ref("azurerm_network_security_group.db", "id") },
      },

      // The app subnet's route table: the db subnet via an address nothing holds.
      { address: "azurerm_route_table.app", values: { name: "rt-app", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_route.app_to_db",
        values: { name: "to-db-via-firewall", resource_group_name: c.rg, route_table_name: "rt-app", address_prefix: "10.64.65.0/24", next_hop_type: "VirtualAppliance", next_hop_in_ip_address: "10.64.79.4" },
        refs: { ...inRg, route_table_name: ref("azurerm_route_table.app", "name"), address_prefix: ["local.db_cidr"], next_hop_in_ip_address: ["local.fw_ip"] },
      },
      {
        address: "azurerm_subnet_route_table_association.app",
        values: {},
        unknown: ["subnet_id", "route_table_id"],
        refs: { subnet_id: ref("azurerm_subnet.app", "id"), route_table_id: ref("azurerm_route_table.app", "id") },
      },

      ...linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.app", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
      ...linuxVm(c, { name: "vm-db", subnet: "azurerm_subnet.db", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 8080)" }),
      agent("app"),
      agent("db"),
    ],
  };
};
