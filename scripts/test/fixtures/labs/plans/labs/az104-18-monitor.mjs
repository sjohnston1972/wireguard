// scripts/test/fixtures/labs/plans/labs/az104-18-monitor.mjs
//
// Plain English: lab 18's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0 computes). A VM with a
// system-assigned identity and the Azure Monitor agent, a capped workspace, a
// data collection rule and its association, an action group with no
// receivers, a CPU metric alert and a VM-restart activity log alert. Every id
// is known only after apply, so everything that points at one is unknown.

import { IN_RG, REGION, ctx, linuxVm, ref, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-18-monitor", "18");
  const vm = "azurerm_linux_virtual_machine.vm";
  const ws = "azurerm_log_analytics_workspace.lab";
  const dcr = "azurerm_monitor_data_collection_rule.vm";
  const ag = "azurerm_monitor_action_group.lab";
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.vms",
        values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"], default_outbound_access_enabled: true },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.vms_cidr"] },
      },
      ...linuxVm(c, { name: "vm-monitor", key: "vm", subnet: "azurerm_subnet.vms", identity: "SystemAssigned" }),
      {
        address: ws,
        values: { name: "log-lab", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_virtual_machine_extension.ama",
        values: { name: "AzureMonitorLinuxAgent", publisher: "Microsoft.Azure.Monitor", type: "AzureMonitorLinuxAgent", type_handler_version: "1.0", auto_upgrade_minor_version: true, automatic_upgrade_enabled: true, tags: c.tags },
        unknown: ["virtual_machine_id"],
        refs: { virtual_machine_id: ref(vm, "id"), tags: ["var.tags"] },
      },
      {
        address: dcr,
        values: {
          name: "dcr-vm-linux",
          resource_group_name: c.rg,
          location: REGION,
          kind: "Linux",
          description: "Two performance counters every 60 s and syslog warnings and above, from the lab VM to log-lab.",
          tags: c.tags,
          destinations: [{ log_analytics: [{ name: "log-lab" }] }],
          data_flow: [{ streams: ["Microsoft-Perf", "Microsoft-Syslog"], destinations: ["log-lab"] }],
          data_sources: [
            {
              performance_counter: [{ name: "perf-basic", streams: ["Microsoft-Perf"], sampling_frequency_in_seconds: 60, counter_specifiers: ["Processor(*)\\% Processor Time", "Memory(*)\\% Used Memory"] }],
              syslog: [{ name: "syslog-warning", streams: ["Microsoft-Syslog"], facility_names: ["*"], log_levels: ["Warning", "Error", "Critical", "Alert", "Emergency"] }],
            },
          ],
        },
        unknown: ["destinations.0.log_analytics.0.workspace_resource_id"],
        refs: { ...IN_RG, "destinations.0.log_analytics.0.workspace_resource_id": ref(ws, "id") },
      },
      {
        address: "azurerm_monitor_data_collection_rule_association.vm",
        values: { name: "dcra-vm-monitor", description: "Sends vm-monitor's counters and syslog through dcr-vm-linux." },
        unknown: ["target_resource_id", "data_collection_rule_id"],
        refs: { target_resource_id: ref(vm, "id"), data_collection_rule_id: ref(dcr, "id") },
      },
      {
        address: ag,
        values: { name: "ag-lab", resource_group_name: c.rg, location: "global", short_name: "lab18", enabled: true, tags: c.tags },
        refs: { resource_group_name: IN_RG.resource_group_name, tags: IN_RG.tags },
      },
      {
        address: "azurerm_monitor_metric_alert.cpu",
        values: {
          name: "alert-vm-cpu-high",
          resource_group_name: c.rg,
          description: "vm-monitor's average CPU is over 80% for 5 minutes.",
          severity: 3,
          frequency: "PT1M",
          window_size: "PT5M",
          tags: c.tags,
          criteria: [{ metric_namespace: "Microsoft.Compute/virtualMachines", metric_name: "Percentage CPU", aggregation: "Average", operator: "GreaterThan", threshold: 80 }],
        },
        unknown: ["scopes", "action.0.action_group_id"],
        refs: { resource_group_name: IN_RG.resource_group_name, tags: IN_RG.tags, scopes: ref(vm, "id"), "action.0.action_group_id": ref(ag, "id") },
      },
      {
        address: "azurerm_monitor_activity_log_alert.restart",
        values: {
          name: "alert-vm-restart",
          resource_group_name: c.rg,
          location: "global",
          description: "A VM in the lab's group was restarted.",
          tags: c.tags,
          criteria: [{ category: "Administrative", operation_name: "Microsoft.Compute/virtualMachines/restart/action" }],
        },
        unknown: ["scopes", "action.0.action_group_id"],
        refs: { resource_group_name: IN_RG.resource_group_name, tags: IN_RG.tags, scopes: ref("azurerm_resource_group.lab", "id"), "action.0.action_group_id": ref(ag, "id") },
      },
    ],
  };
};
