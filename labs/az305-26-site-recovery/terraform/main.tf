# main.tf
#
# Plain English: Azure-to-Azure disaster recovery for one small VM, with
# Azure Site Recovery (labs spec §17, ruling 32).
#
# The source, in rg-lab-<id> (the session's region, uksouth): vnet-source
# (the first /20 of the slot) with one Standard_B1s Ubuntu 22.04 VM, vm-app,
# no public IP, serving "<hostname> in <region>" on port 80; and a cache
# storage account, where Site Recovery stages the VM's disk writes before
# they cross to the other region.
#
# The target, in rg-lab-<id>-secondary (the secondary region, ukwest): the
# Recovery Services vault, vnet-target (the slot's second /20, where a
# failover puts the VM) and vnet-test (the third /20, an isolated network
# for test failovers). Inside the vault: a fabric and a protection container
# for each region, a replication policy (6 hours of crash-consistent
# recovery points), the mapping between the containers (agent auto-update
# off, so no automation account is made), the mapping from vnet-source to
# vnet-target, and the replicated VM. Its replica disk, its failover and
# test failover VMs and their NICs are all made in rg-lab-<id>-secondary:
# nothing Site Recovery makes lands outside the lab's two groups.
#
# Terraform waits for the initial replication to finish before the lab is
# ready. Tear-down disables replication first; the unblock step cleans up a
# test failover, removes replication and the mappings if Terraform cannot,
# and turns the vault's soft delete off (lab 19's path).

locals {
  # One /20 of the slot per network; each subnet is the first /24 of its /20.
  source_cidr = cidrsubnet(var.address_space, 2, 0)
  target_cidr = cidrsubnet(var.address_space, 2, 1)
  test_cidr   = cidrsubnet(var.address_space, 2, 2)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_resource_group" "secondary" {
  name     = "${var.resource_group_name}-secondary"
  location = var.secondary_region
  tags     = var.tags
}

# ── The source: a VM in the session's region ─────────────────────────────

resource "azurerm_virtual_network" "source" {
  name                = "vnet-source"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.source_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "source" {
  name                 = "snet-vms"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.source.name
  address_prefixes     = [cidrsubnet(local.source_cidr, 4, 0)]
  # Ruling 37: the VM has no public IP, and Site Recovery's Mobility agent
  # must reach Site Recovery, Storage and Entra ID. Default outbound access
  # does that without a NAT gateway (which would cost more than the VM).
  default_outbound_access_enabled = true
}

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.source.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "vm-app"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.vm.id]
  custom_data                     = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))
  tags                            = var.tags

  dynamic "admin_ssh_key" {
    for_each = var.ssh_public_key == "" ? [] : [var.ssh_public_key]
    content {
      username   = "azureuser"
      public_key = admin_ssh_key.value
    }
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  # Ubuntu 22.04 Gen2: its kernel series is on Site Recovery's
  # Azure-to-Azure support matrix. The standard security type (no Trusted
  # Launch settings), as the support matrix's widest row.
  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  # Managed boot diagnostics: the portal's serial console works with no
  # storage account of our own.
  boot_diagnostics {}
}

# Site Recovery stages the VM's disk writes here, in the source region,
# before they are copied to the replica disk in the target region. LRS
# StorageV2 with shared keys on and no blob soft delete (Site Recovery does
# not support soft delete on a cache account).
resource "azurerm_storage_account" "cache" {
  name                            = "${var.name_prefix}cache"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  tags                            = var.tags
}

# ── The target: the vault and two networks in the secondary region ───────

resource "azurerm_recovery_services_vault" "lab" {
  name                         = "rsv-lab"
  resource_group_name          = azurerm_resource_group.secondary.name
  location                     = azurerm_resource_group.secondary.location
  sku                          = "Standard"
  storage_mode_type            = "LocallyRedundant"
  cross_region_restore_enabled = false
  # On: azurerm refuses a new vault with soft delete off ("Soft Delete is a
  # required security feature"). Never always-on: before a destroy the
  # unblock step turns it off, so nothing soft-deleted can keep the vault.
  soft_delete_enabled = true
  # Never "Locked": a locked vault cannot be deleted until its data expires.
  immutability                  = "Disabled"
  public_network_access_enabled = true
  tags                          = var.tags
}

# Where a failover puts the VM: the same subnet name as the source, so the
# NIC keeps its subnet.
resource "azurerm_virtual_network" "target" {
  name                = "vnet-target"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  address_space       = [local.target_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "target" {
  name                 = "snet-vms"
  resource_group_name  = azurerm_resource_group.secondary.name
  virtual_network_name = azurerm_virtual_network.target.name
  address_prefixes     = [cidrsubnet(local.target_cidr, 4, 0)]
  # The failed-over VM keeps the source's outbound access (ruling 37).
  default_outbound_access_enabled = true
}

# An isolated network for test failovers: nothing connects to it, so a test
# copy of the VM never meets the real one.
resource "azurerm_virtual_network" "test" {
  name                = "vnet-test"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  address_space       = [local.test_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "test" {
  name                            = "snet-vms"
  resource_group_name             = azurerm_resource_group.secondary.name
  virtual_network_name            = azurerm_virtual_network.test.name
  address_prefixes                = [cidrsubnet(local.test_cidr, 4, 0)]
  default_outbound_access_enabled = true
}

# ── Site Recovery, inside the vault ──────────────────────────────────────

# A fabric and a protection container for each region (what the portal
# makes as asr-a2a-default-<region>).
resource "azurerm_site_recovery_fabric" "source" {
  name                = "fabric-${var.region}"
  resource_group_name = azurerm_resource_group.secondary.name
  recovery_vault_name = azurerm_recovery_services_vault.lab.name
  location            = azurerm_resource_group.lab.location
}

resource "azurerm_site_recovery_fabric" "target" {
  name                = "fabric-${var.secondary_region}"
  resource_group_name = azurerm_resource_group.secondary.name
  recovery_vault_name = azurerm_recovery_services_vault.lab.name
  location            = azurerm_resource_group.secondary.location
}

resource "azurerm_site_recovery_protection_container" "source" {
  name                 = "container-${var.region}"
  resource_group_name  = azurerm_resource_group.secondary.name
  recovery_vault_name  = azurerm_recovery_services_vault.lab.name
  recovery_fabric_name = azurerm_site_recovery_fabric.source.name
}

resource "azurerm_site_recovery_protection_container" "target" {
  name                 = "container-${var.secondary_region}"
  resource_group_name  = azurerm_resource_group.secondary.name
  recovery_vault_name  = azurerm_recovery_services_vault.lab.name
  recovery_fabric_name = azurerm_site_recovery_fabric.target.name
}

# Crash-consistent recovery points every few minutes, kept 6 hours; no
# app-consistent snapshots (they need extra work inside the VM, and a B1s
# has little to spare).
resource "azurerm_site_recovery_replication_policy" "lab" {
  name                                                 = "policy-6h"
  resource_group_name                                  = azurerm_resource_group.secondary.name
  recovery_vault_name                                  = azurerm_recovery_services_vault.lab.name
  recovery_point_retention_in_minutes                  = 360
  application_consistent_snapshot_frequency_in_minutes = 0
}

resource "azurerm_site_recovery_protection_container_mapping" "lab" {
  name                                      = "mapping-${var.region}-${var.secondary_region}"
  resource_group_name                       = azurerm_resource_group.secondary.name
  recovery_vault_name                       = azurerm_recovery_services_vault.lab.name
  recovery_fabric_name                      = azurerm_site_recovery_fabric.source.name
  recovery_source_protection_container_name = azurerm_site_recovery_protection_container.source.name
  recovery_target_protection_container_id   = azurerm_site_recovery_protection_container.target.id
  recovery_replication_policy_id            = azurerm_site_recovery_replication_policy.lab.id

  # Off: updating the Mobility agent automatically needs an automation
  # account, which would be one more thing to make, pay for and remove.
  automatic_update {
    enabled = false
  }
}

resource "azurerm_site_recovery_network_mapping" "lab" {
  name                        = "map-vnet-source-vnet-target"
  resource_group_name         = azurerm_resource_group.secondary.name
  recovery_vault_name         = azurerm_recovery_services_vault.lab.name
  source_recovery_fabric_name = azurerm_site_recovery_fabric.source.name
  target_recovery_fabric_name = azurerm_site_recovery_fabric.target.name
  source_network_id           = azurerm_virtual_network.source.id
  target_network_id           = azurerm_virtual_network.target.id
}

# Replication of vm-app into rg-lab-<id>-secondary. Everything it makes
# (the replica disk, and on failover the VM, its NIC and its disk) goes into
# that group: never re-protect into another one.
resource "azurerm_site_recovery_replicated_vm" "vm" {
  name                                      = "vm-app"
  resource_group_name                       = azurerm_resource_group.secondary.name
  recovery_vault_name                       = azurerm_recovery_services_vault.lab.name
  source_recovery_fabric_name               = azurerm_site_recovery_fabric.source.name
  source_vm_id                              = azurerm_linux_virtual_machine.vm.id
  recovery_replication_policy_id            = azurerm_site_recovery_replication_policy.lab.id
  source_recovery_protection_container_name = azurerm_site_recovery_protection_container.source.name
  target_resource_group_id                  = azurerm_resource_group.secondary.id
  target_recovery_fabric_id                 = azurerm_site_recovery_fabric.target.id
  target_recovery_protection_container_id   = azurerm_site_recovery_protection_container.target.id
  target_network_id                         = azurerm_virtual_network.target.id
  test_network_id                           = azurerm_virtual_network.test.id
  # The source VM's size: the B-series quota counts it once more in ukwest.
  target_virtual_machine_size = "Standard_B1s"

  managed_disk {
    disk_id                    = azurerm_linux_virtual_machine.vm.os_disk[0].id
    staging_storage_account_id = azurerm_storage_account.cache.id
    target_resource_group_id   = azurerm_resource_group.secondary.id
    target_disk_type           = "Standard_LRS"
    target_replica_disk_type   = "Standard_LRS"
  }

  network_interface {
    source_network_interface_id = azurerm_network_interface.vm.id
    target_subnet_name          = azurerm_subnet.target.name
    failover_test_subnet_name   = azurerm_subnet.test.name
  }

  depends_on = [
    azurerm_site_recovery_protection_container_mapping.lab,
    azurerm_site_recovery_network_mapping.lab,
  ]
}
