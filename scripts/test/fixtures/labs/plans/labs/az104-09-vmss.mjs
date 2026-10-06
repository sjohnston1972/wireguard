// az104-09-vmss.mjs: lab 9's first-deploy plan, as labs/az104-09-vmss/terraform/main.tf
// builds it (a Uniform scale set of two B1s instances and an autoscale
// setting on CPU). Fake ids; realistic.mjs adds what Azure computes.

import { ctx, IN_RG, REGION, SSH_KEY, ref, rgResource } from "../common.mjs";

const VMSS = "azurerm_linux_virtual_machine_scale_set.web";

/** One autoscale rule on the scale set's average CPU. */
const cpuRule = (operator, threshold, direction) => ({
  metric_trigger: [{ metric_name: "Percentage CPU", metric_namespace: "microsoft.compute/virtualmachinescalesets", time_grain: "PT1M", statistic: "Average", time_window: "PT5M", time_aggregation: "Average", operator, threshold }],
  scale_action: [{ direction, type: "ChangeCount", value: "1", cooldown: "PT5M" }],
});

export default () => {
  const c = ctx("az104-09-vmss", "09");
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
      {
        address: VMSS,
        values: {
          name: "vmss-web",
          resource_group_name: c.rg,
          location: REGION,
          sku: "Standard_B1s",
          instances: 2,
          upgrade_mode: "Manual",
          overprovision: false,
          admin_username: "azureuser",
          admin_password: "(the session's admin password)",
          disable_password_authentication: false,
          // filebase64 of cloud-init.yaml: a file in the module, known at plan.
          custom_data: "I2Nsb3VkLWNvbmZpZwo=",
          tags: c.tags,
          admin_ssh_key: [{ username: "azureuser", public_key: SSH_KEY }],
          source_image_reference: [{ publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" }],
          os_disk: [{ caching: "ReadWrite", storage_account_type: "Standard_LRS" }],
          network_interface: [{ name: "nic-vmss-web", primary: true, ip_configuration: [{ name: "ipconfig1", primary: true }] }],
          boot_diagnostics: [{}],
        },
        unknown: ["network_interface.0.ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, admin_password: ["var.admin_password"], custom_data: ["path.module"], "network_interface.0.ip_configuration.0.subnet_id": ref("azurerm_subnet.vms", "id") },
        // A dynamic block: planned, but left out of the configuration (no references), as real plans print it.
        dynamic: ["admin_ssh_key"],
        sensitive: ["admin_password", "custom_data"],
      },
      {
        address: "azurerm_monitor_autoscale_setting.web",
        values: {
          name: "autoscale-vmss-web",
          resource_group_name: c.rg,
          location: REGION,
          enabled: true,
          tags: c.tags,
          profile: [{ name: "cpu", capacity: [{ default: 2, minimum: 1, maximum: 3 }], rule: [cpuRule("GreaterThan", 70, "Increase"), cpuRule("LessThan", 25, "Decrease")] }],
        },
        unknown: ["target_resource_id", "profile.0.rule.0.metric_trigger.0.metric_resource_id", "profile.0.rule.1.metric_trigger.0.metric_resource_id"],
        refs: {
          ...IN_RG,
          target_resource_id: ref(VMSS, "id"),
          "profile.0.rule.0.metric_trigger.0.metric_resource_id": ref(VMSS, "id"),
          "profile.0.rule.1.metric_trigger.0.metric_resource_id": ref(VMSS, "id"),
        },
      },
    ],
  };
};
