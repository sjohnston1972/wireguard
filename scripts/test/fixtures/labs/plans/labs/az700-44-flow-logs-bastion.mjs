// scripts/test/fixtures/labs/plans/labs/az700-44-flow-logs-bastion.mjs
//
// Plain English: lab 44's first-deploy plan, written out from
// labs/az700-44-flow-logs-bastion/terraform/main.tf with a real session's
// values at slot 31 (10.71.192.0/18): vnet-hub 10.71.192.0/20,
// AzureBastionSubnet 10.71.192.0/26, snet-web 10.71.193.0/24, snet-app
// 10.71.194.0/24 (the NSG rules name them through locals, known at plan).
// The flow log (scope exception S2) is in NetworkWatcherRG on
// NetworkWatcher_uksouth, named from var.lab_id, its target, account and
// workspace ids known only after apply; the workspace's region is known
// (its location is the group's).

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az700-44-flow-logs-bastion", "44", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const ws = "azurerm_log_analytics_workspace.lab";
  const subnet = (key, name, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: "vnet-hub", address_prefixes: [cidr], default_outbound_access_enabled: true },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.hub", "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const nsg = (key) => ({ address: `azurerm_network_security_group.${key}`, values: { name: `nsg-${key}`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG });
  const LOCAL_CIDRS = { "local.bastion_cidr": "10.71.192.0/26", "local.web_cidr": "10.71.193.0/24", "local.app_cidr": "10.71.194.0/24" };
  const rule = (key, nsgKey, v) => {
    const values = { resource_group_name: c.rg, network_security_group_name: `nsg-${nsgKey}`, source_port_range: "*", ...v };
    const refs = { ...inRg, network_security_group_name: ref(`azurerm_network_security_group.${nsgKey}`, "name") };
    if (v.source_address_prefix in LOCAL_CIDRS) {
      refs.source_address_prefix = [v.source_address_prefix];
      values.source_address_prefix = LOCAL_CIDRS[v.source_address_prefix];
    }
    return { address: `azurerm_network_security_rule.${key}`, values, refs };
  };
  const nsgOn = (key) => ({
    address: `azurerm_subnet_network_security_group_association.${key}`,
    values: {},
    unknown: ["subnet_id", "network_security_group_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), network_security_group_id: ref(`azurerm_network_security_group.${key}`, "id") },
  });
  const allowIn = { direction: "Inbound", access: "Allow" };
  const allowOut = { direction: "Outbound", access: "Allow" };
  const vm = (key) => linuxVm(c, { name: `vm-${key}`, key, subnet: `azurerm_subnet.${key}`, customData: `I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, vm-${key})` });
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
      { address: "azurerm_virtual_network.hub", values: { name: "vnet-hub", resource_group_name: c.rg, location: REGION, address_space: ["10.71.192.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.hub_cidr"] } },
      subnet("bastion", "AzureBastionSubnet", "10.71.192.0/26"),
      subnet("web", "snet-web", "10.71.193.0/24"),
      subnet("app", "snet-app", "10.71.194.0/24"),

      // AzureBastionSubnet's NSG, as Learn documents it.
      nsg("bastion"),
      rule("bastion_https_in", "bastion", { ...allowIn, name: "AllowHttpsInbound", priority: 120, protocol: "Tcp", destination_port_range: "443", source_address_prefix: "Internet", destination_address_prefix: "*" }),
      rule("bastion_gateway_manager_in", "bastion", { ...allowIn, name: "AllowGatewayManagerInbound", priority: 130, protocol: "Tcp", destination_port_range: "443", source_address_prefix: "GatewayManager", destination_address_prefix: "*" }),
      rule("bastion_load_balancer_in", "bastion", { ...allowIn, name: "AllowAzureLoadBalancerInbound", priority: 140, protocol: "Tcp", destination_port_range: "443", source_address_prefix: "AzureLoadBalancer", destination_address_prefix: "*" }),
      rule("bastion_host_in", "bastion", { ...allowIn, name: "AllowBastionHostCommunication", priority: 150, protocol: "*", destination_port_ranges: ["8080", "5701"], source_address_prefix: "VirtualNetwork", destination_address_prefix: "VirtualNetwork" }),
      rule("bastion_ssh_rdp_out", "bastion", { ...allowOut, name: "AllowSshRdpOutbound", priority: 100, protocol: "*", destination_port_ranges: ["22", "3389"], source_address_prefix: "*", destination_address_prefix: "VirtualNetwork" }),
      rule("bastion_azure_cloud_out", "bastion", { ...allowOut, name: "AllowAzureCloudOutbound", priority: 110, protocol: "Tcp", destination_port_range: "443", source_address_prefix: "*", destination_address_prefix: "AzureCloud" }),
      rule("bastion_host_out", "bastion", { ...allowOut, name: "AllowBastionCommunication", priority: 120, protocol: "*", destination_port_ranges: ["8080", "5701"], source_address_prefix: "VirtualNetwork", destination_address_prefix: "VirtualNetwork" }),
      rule("bastion_http_out", "bastion", { ...allowOut, name: "AllowHttpOutbound", priority: 130, protocol: "*", destination_port_range: "80", source_address_prefix: "*", destination_address_prefix: "Internet" }),
      nsgOn("bastion"),

      // snet-web and snet-app.
      nsg("web"),
      rule("web_ssh_bastion", "web", { ...allowIn, name: "allow-ssh-from-bastion", priority: 100, protocol: "Tcp", destination_port_range: "22", source_address_prefix: "local.bastion_cidr", destination_address_prefix: "*" }),
      rule("web_deny_app", "web", { direction: "Inbound", access: "Deny", name: "deny-from-app", priority: 110, protocol: "*", destination_port_range: "*", source_address_prefix: "local.app_cidr", destination_address_prefix: "*" }),
      rule("web_deny_ssh", "web", { direction: "Inbound", access: "Deny", name: "deny-ssh-from-vnet", priority: 120, protocol: "Tcp", destination_port_range: "22", source_address_prefix: "VirtualNetwork", destination_address_prefix: "*" }),
      nsgOn("web"),
      nsg("app"),
      rule("app_ssh_bastion", "app", { ...allowIn, name: "allow-ssh-from-bastion", priority: 100, protocol: "Tcp", destination_port_range: "22", source_address_prefix: "local.bastion_cidr", destination_address_prefix: "*" }),
      rule("app_http_web", "app", { ...allowIn, name: "allow-http-from-web", priority: 110, protocol: "Tcp", destination_port_range: "80", source_address_prefix: "local.web_cidr", destination_address_prefix: "*" }),
      rule("app_deny_vnet", "app", { direction: "Inbound", access: "Deny", name: "deny-vnet-inbound", priority: 120, protocol: "*", destination_port_range: "*", source_address_prefix: "VirtualNetwork", destination_address_prefix: "*" }),
      nsgOn("app"),

      // The VMs and their Network Watcher agents.
      ...vm("web"),
      ...vm("app"),
      agent("web"),
      agent("app"),

      // Bastion Basic.
      { address: "azurerm_public_ip.bastion", values: { name: "pip-bastion", resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_bastion_host.hub",
        values: { name: "bas-hub", resource_group_name: c.rg, location: REGION, sku: "Basic", tags: c.tags, ip_configuration: [{ name: "ipconfig1" }] },
        unknown: ["ip_configuration.0.subnet_id", "ip_configuration.0.public_ip_address_id"],
        refs: { ...IN_RG, "ip_configuration.0.subnet_id": ref("azurerm_subnet.bastion", "id"), "ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.bastion", "id") },
      },

      // The flow log, its account and workspace.
      {
        address: "azurerm_storage_account.flow",
        values: {
          name: `${c.prefix}flow`,
          resource_group_name: c.rg,
          location: REGION,
          account_kind: "StorageV2",
          account_tier: "Standard",
          account_replication_type: "LRS",
          min_tls_version: "TLS1_2",
          https_traffic_only_enabled: true,
          allow_nested_items_to_be_public: false,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      {
        address: ws,
        values: { name: "log-flow", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_network_watcher_flow_log.vnet",
        values: {
          name: `lab-${c.id}-vnet`,
          resource_group_name: "NetworkWatcherRG",
          network_watcher_name: `NetworkWatcher_${REGION}`,
          location: REGION,
          enabled: true,
          version: 2,
          tags: c.tags,
          retention_policy: [{ enabled: true, days: 1 }],
          traffic_analytics: [{ enabled: true, interval_in_minutes: 10, workspace_region: REGION }],
        },
        unknown: ["target_resource_id", "storage_account_id", "traffic_analytics.0.workspace_id", "traffic_analytics.0.workspace_resource_id"],
        refs: {
          name: ["var.lab_id"],
          network_watcher_name: ["var.region"],
          location: ["var.region"],
          target_resource_id: ref("azurerm_virtual_network.hub", "id"),
          storage_account_id: ref("azurerm_storage_account.flow", "id"),
          tags: ["var.tags"],
          "traffic_analytics.0.workspace_id": ref(ws, "workspace_id"),
          "traffic_analytics.0.workspace_region": ref(ws, "location"),
          "traffic_analytics.0.workspace_resource_id": ref(ws, "id"),
        },
      },
    ],
  };
};
