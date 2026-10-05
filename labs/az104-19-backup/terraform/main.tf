# main.tf
#
# Plain English: Azure Backup for one small VM. A Recovery Services vault
# (Standard, locally redundant) protects a Standard_B1s Ubuntu VM with no
# public IP under a daily Enhanced policy that keeps 7 daily recovery points
# and one day of instant-restore snapshots. Azure keeps those snapshots in a
# resource group it makes itself, named from the policy's prefix:
# rg-lab-<id>-irp1, inside the lab's sweep. The vault is made so tear-down
# can always empty and delete it: soft delete off (deleted backup data is
# gone at once, not kept for 14 days) and immutability Disabled. Terraform
# never waits for a backup: the first one runs when you press Backup now, or
# at 23:00 UTC. An empty storage account is where a restore stages the VM's
# configuration and disks. Reach the VM over the tunnel when peered, or
# through the portal's serial console or Run command.

locals {
  # The first /20 of the slot; the VM subnet is its first /24.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  vms_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "vms" {
  name                 = "snet-vms"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.vms_cidr]
  # The VM has no public IP; Azure's default outbound access lets its agent
  # install and run the backup extension without a NAT gateway (which would
  # cost more than the VM).
  default_outbound_access_enabled = true
}

# ── The VM ────────────────────────────────────────────────────────────────

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm-backup"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.vms.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "vm-backup"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.vm.id]
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

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # Managed boot diagnostics: the portal's serial console works with no
  # storage account of our own.
  boot_diagnostics {}
}

# ── Restore staging ──────────────────────────────────────────────────────

# Restoring to a new VM (or restoring disks) needs a storage account in the
# vault's region to stage through. Empty until you restore.
resource "azurerm_storage_account" "staging" {
  name                            = "${var.name_prefix}stage"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

# ── The vault, the policy and the protected VM ───────────────────────────

resource "azurerm_recovery_services_vault" "lab" {
  name                         = "rsv-lab"
  resource_group_name          = azurerm_resource_group.lab.name
  location                     = azurerm_resource_group.lab.location
  sku                          = "Standard"
  storage_mode_type            = "LocallyRedundant"
  cross_region_restore_enabled = false
  # Off, so tear-down deletes backup data at once and the vault can go.
  # (Deprecated in azurerm 4.x but still sent; the unblock step turns soft
  # delete off again before a destroy in case it was turned on by hand.)
  soft_delete_enabled = false
  # Never "Locked": a locked vault cannot be deleted until its data expires.
  immutability                  = "Disabled"
  public_network_access_enabled = true
  tags                          = var.tags
}

resource "azurerm_backup_policy_vm" "daily" {
  name                = "policy-daily-7d"
  resource_group_name = azurerm_resource_group.lab.name
  recovery_vault_name = azurerm_recovery_services_vault.lab.name
  # Enhanced: it backs up Trusted Launch VMs as well as standard ones.
  policy_type = "V2"
  timezone    = "UTC"

  # Snapshots kept one day for instant restore, in rg-lab-<id>-irp1 (Azure
  # appends the 1): inside the lab's sweep.
  instant_restore_retention_days = 1
  instant_restore_resource_group {
    prefix = "${var.resource_group_name}-irp"
  }

  backup {
    frequency = "Daily"
    time      = "23:00"
  }

  retention_daily {
    count = 7
  }
}

# Enabling protection takes a minute or two; it does not run a backup.
resource "azurerm_backup_protected_vm" "vm" {
  resource_group_name = azurerm_resource_group.lab.name
  recovery_vault_name = azurerm_recovery_services_vault.lab.name
  source_vm_id        = azurerm_linux_virtual_machine.vm.id
  backup_policy_id    = azurerm_backup_policy_vm.daily.id
}
