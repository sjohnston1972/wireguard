// scripts/test/fixtures/labs/plans/labs/az104-19-backup.mjs
//
// Plain English: lab 19's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0 computes). A Recovery Services
// vault (Standard, LRS, soft delete on, immutability off), a daily Enhanced
// policy whose restore points go to rg-lab-<id>-irp (Azure appends 1), the
// VM it protects and an empty storage account restores stage through. The
// vault's name is known at plan (a literal), so the policy and the protected
// item know it too; the VM's and the policy's ids are not.

import { IN_RG, REGION, ctx, linuxVm, ref, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-19-backup", "19");
  const vault = "azurerm_recovery_services_vault.lab";
  const policy = "azurerm_backup_policy_vm.daily";
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
      ...linuxVm(c, { name: "vm-backup", key: "vm", subnet: "azurerm_subnet.vms" }),
      {
        address: "azurerm_storage_account.staging",
        values: {
          name: `${c.prefix}stage`,
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
        address: vault,
        values: {
          name: "rsv-lab",
          resource_group_name: c.rg,
          location: REGION,
          sku: "Standard",
          storage_mode_type: "LocallyRedundant",
          cross_region_restore_enabled: false,
          soft_delete_enabled: true,
          immutability: "Disabled",
          public_network_access_enabled: true,
          tags: c.tags,
        },
        refs: IN_RG,
      },
      {
        address: policy,
        values: {
          name: "policy-daily-7d",
          resource_group_name: c.rg,
          recovery_vault_name: "rsv-lab",
          policy_type: "V2",
          timezone: "UTC",
          instant_restore_retention_days: 1,
          instant_restore_resource_group: [{ prefix: `${c.rg}-irp` }],
          backup: [{ frequency: "Daily", time: "23:00" }],
          retention_daily: [{ count: 7 }],
        },
        refs: { resource_group_name: IN_RG.resource_group_name, recovery_vault_name: ref(vault, "name"), "instant_restore_resource_group.0.prefix": ["var.resource_group_name"] },
      },
      {
        address: "azurerm_backup_protected_vm.vm",
        values: { resource_group_name: c.rg, recovery_vault_name: "rsv-lab" },
        unknown: ["source_vm_id", "backup_policy_id"],
        refs: { resource_group_name: IN_RG.resource_group_name, recovery_vault_name: ref(vault, "name"), source_vm_id: ref("azurerm_linux_virtual_machine.vm", "id"), backup_policy_id: ref(policy, "id") },
      },
    ],
  };
};
