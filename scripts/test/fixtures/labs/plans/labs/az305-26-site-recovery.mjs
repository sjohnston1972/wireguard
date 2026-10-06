// scripts/test/fixtures/labs/plans/labs/az305-26-site-recovery.mjs
//
// Plain English: lab 26's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what azurerm 4.81.0 computes). A VM, its
// network and a cache account in rg-lab-<id> (uksouth); the vault, the target
// and test networks and every Site Recovery object in rg-lab-<id>-secondary
// (ukwest). Names built from variables and literals are known at plan; every
// id is not. The replicated VM's managed_disk and network_interface are
// attributes written as blocks (azurerm's schema types them set(object)), so
// Terraform lists all their references under the attribute itself, and an
// unknown value inside them carries no references of its own; a reference
// through a literal index (os_disk[0].id) is listed with each shorter
// traversal, down to the resource.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, rgSecondaryResource, SECONDARY } from "../common.mjs";

/** A resource inside rg-lab-<id>-secondary: its group's name and location, and var.tags. */
const IN_RG2 = { resource_group_name: ref("azurerm_resource_group.secondary", "name"), location: ref("azurerm_resource_group.secondary", "location"), tags: ["var.tags"] };

export default () => {
  const c = ctx("az305-26-site-recovery", "26");
  const vault = "azurerm_recovery_services_vault.lab";
  const vm = "azurerm_linux_virtual_machine.vm";
  // Slot 1 (10.64.64.0/18): /20s 0, 1 and 2, each subnet the /20's first /24.
  const net = (key, rg, location, cidr, sub, refsIn, local) => [
    { address: `azurerm_virtual_network.${key}`, values: { name: `vnet-${key}`, resource_group_name: rg, location, address_space: [cidr], tags: c.tags }, refs: { ...refsIn, address_space: [`local.${local}`] } },
    {
      address: `azurerm_subnet.${key}`,
      values: { name: "snet-vms", resource_group_name: rg, virtual_network_name: `vnet-${key}`, address_prefixes: [sub], default_outbound_access_enabled: true },
      refs: { resource_group_name: refsIn.resource_group_name, virtual_network_name: ref(`azurerm_virtual_network.${key}`, "name"), address_prefixes: [`local.${local}`] },
    },
  ];
  const inVault = (extra = {}) => ({ resource_group_name: IN_RG2.resource_group_name, recovery_vault_name: ref(vault, "name"), ...extra });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      rgSecondaryResource(c),
      // The source, in uksouth.
      ...net("source", c.rg, REGION, "10.64.64.0/20", "10.64.64.0/24", IN_RG, "source_cidr"),
      ...linuxVm(c, { name: "vm-app", key: "vm", subnet: "azurerm_subnet.source", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)", image: { publisher: "almalinux", offer: "almalinux-x86_64", sku: "9-gen2", version: "9.7.2026051801" } }),
      {
        address: "azurerm_storage_account.cache",
        values: {
          name: `${c.prefix}cache`,
          resource_group_name: c.rg,
          location: REGION,
          account_kind: "StorageV2",
          account_tier: "Standard",
          account_replication_type: "LRS",
          min_tls_version: "TLS1_2",
          https_traffic_only_enabled: true,
          allow_nested_items_to_be_public: false,
          shared_access_key_enabled: true,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      // The target, in ukwest.
      {
        address: vault,
        values: {
          name: "rsv-lab",
          resource_group_name: c.rgSecondary,
          location: SECONDARY,
          sku: "Standard",
          storage_mode_type: "LocallyRedundant",
          cross_region_restore_enabled: false,
          soft_delete_enabled: true,
          immutability: "Disabled",
          public_network_access_enabled: true,
          tags: c.tags,
        },
        refs: IN_RG2,
      },
      ...net("target", c.rgSecondary, SECONDARY, "10.64.80.0/20", "10.64.80.0/24", IN_RG2, "target_cidr"),
      ...net("test", c.rgSecondary, SECONDARY, "10.64.96.0/20", "10.64.96.0/24", IN_RG2, "test_cidr"),
      // Site Recovery, inside the vault.
      { address: "azurerm_site_recovery_fabric.source", values: { name: `fabric-${REGION}`, resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", location: REGION }, refs: inVault({ name: ["var.region"], location: ref("azurerm_resource_group.lab", "location") }) },
      { address: "azurerm_site_recovery_fabric.target", values: { name: `fabric-${SECONDARY}`, resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", location: SECONDARY }, refs: inVault({ name: ["var.secondary_region"], location: IN_RG2.location }) },
      {
        address: "azurerm_site_recovery_protection_container.source",
        values: { name: `container-${REGION}`, resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", recovery_fabric_name: `fabric-${REGION}` },
        refs: inVault({ name: ["var.region"], recovery_fabric_name: ref("azurerm_site_recovery_fabric.source", "name") }),
      },
      {
        address: "azurerm_site_recovery_protection_container.target",
        values: { name: `container-${SECONDARY}`, resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", recovery_fabric_name: `fabric-${SECONDARY}` },
        refs: inVault({ name: ["var.secondary_region"], recovery_fabric_name: ref("azurerm_site_recovery_fabric.target", "name") }),
      },
      {
        address: "azurerm_site_recovery_replication_policy.lab",
        values: { name: "policy-6h", resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", recovery_point_retention_in_minutes: 360, application_consistent_snapshot_frequency_in_minutes: 0 },
        refs: inVault(),
      },
      {
        address: "azurerm_site_recovery_protection_container_mapping.lab",
        values: {
          name: `mapping-${REGION}-${SECONDARY}`,
          resource_group_name: c.rgSecondary,
          recovery_vault_name: "rsv-lab",
          recovery_fabric_name: `fabric-${REGION}`,
          recovery_source_protection_container_name: `container-${REGION}`,
          automatic_update: [{ enabled: false }],
        },
        unknown: ["recovery_target_protection_container_id", "recovery_replication_policy_id"],
        refs: inVault({
          name: ["var.region", "var.secondary_region"],
          recovery_fabric_name: ref("azurerm_site_recovery_fabric.source", "name"),
          recovery_source_protection_container_name: ref("azurerm_site_recovery_protection_container.source", "name"),
          recovery_target_protection_container_id: ref("azurerm_site_recovery_protection_container.target", "id"),
          recovery_replication_policy_id: ref("azurerm_site_recovery_replication_policy.lab", "id"),
        }),
      },
      {
        address: "azurerm_site_recovery_network_mapping.lab",
        values: { name: "map-vnet-source-vnet-target", resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", source_recovery_fabric_name: `fabric-${REGION}`, target_recovery_fabric_name: `fabric-${SECONDARY}` },
        unknown: ["source_network_id", "target_network_id"],
        refs: inVault({
          source_recovery_fabric_name: ref("azurerm_site_recovery_fabric.source", "name"),
          target_recovery_fabric_name: ref("azurerm_site_recovery_fabric.target", "name"),
          source_network_id: ref("azurerm_virtual_network.source", "id"),
          target_network_id: ref("azurerm_virtual_network.target", "id"),
        }),
      },
      {
        address: "azurerm_site_recovery_replicated_vm.vm",
        values: {
          name: "vm-app",
          resource_group_name: c.rgSecondary,
          recovery_vault_name: "rsv-lab",
          source_recovery_fabric_name: `fabric-${REGION}`,
          source_recovery_protection_container_name: `container-${REGION}`,
          target_virtual_machine_size: "Standard_B1s",
          managed_disk: [{ target_disk_type: "Standard_LRS", target_replica_disk_type: "Standard_LRS" }],
          network_interface: [{ target_subnet_name: "snet-vms", failover_test_subnet_name: "snet-vms" }],
        },
        unknown: [
          "source_vm_id",
          "recovery_replication_policy_id",
          "target_resource_group_id",
          "target_recovery_fabric_id",
          "target_recovery_protection_container_id",
          "target_network_id",
          "test_network_id",
          "managed_disk.0.disk_id",
          "managed_disk.0.staging_storage_account_id",
          "managed_disk.0.target_resource_group_id",
          "network_interface.0.source_network_interface_id",
        ],
        refs: inVault({
          source_recovery_fabric_name: ref("azurerm_site_recovery_fabric.source", "name"),
          source_vm_id: ref(vm, "id"),
          recovery_replication_policy_id: ref("azurerm_site_recovery_replication_policy.lab", "id"),
          source_recovery_protection_container_name: ref("azurerm_site_recovery_protection_container.source", "name"),
          target_resource_group_id: ref("azurerm_resource_group.secondary", "id"),
          target_recovery_fabric_id: ref("azurerm_site_recovery_fabric.target", "id"),
          target_recovery_protection_container_id: ref("azurerm_site_recovery_protection_container.target", "id"),
          target_network_id: ref("azurerm_virtual_network.target", "id"),
          test_network_id: ref("azurerm_virtual_network.test", "id"),
          // Attributes written as blocks: one reference list for the attribute.
          managed_disk: [
            `${vm}.os_disk[0].id`,
            `${vm}.os_disk[0]`,
            `${vm}.os_disk`,
            vm,
            ...ref("azurerm_storage_account.cache", "id"),
            ...ref("azurerm_resource_group.secondary", "id"),
          ],
          network_interface: [...ref("azurerm_network_interface.vm", "id"), ...ref("azurerm_subnet.target", "name"), ...ref("azurerm_subnet.test", "name")],
        }),
      },
    ],
  };
};
