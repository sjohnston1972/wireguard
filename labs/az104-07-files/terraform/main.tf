# main.tf
#
# Plain English: an Azure Files share seen from the inside. A standard
# (pay-for-what-you-store) storage account holds a small SMB share. Its
# firewall denies everything except the VM subnet, which reaches it through
# a Microsoft.Storage service endpoint. A Standard_B1s Ubuntu VM with no
# public IP sits in that subnet; at first boot cloud-init installs
# cifs-utils and mounts the share at /mnt/labshare, using the account key
# Terraform reads at deploy time. The key goes only into a root-only
# credentials file on the VM (cloud-init.yaml.tftpl), never into a command
# or a log line. Reach the VM over the tunnel when peered, or through the
# portal's serial console or Run command.

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
  service_endpoints    = ["Microsoft.Storage"]
  # The VM has no public IP; Azure's default outbound access lets apt fetch
  # cifs-utils without a NAT gateway (which would cost more than the VM).
  default_outbound_access_enabled = true
}

# ── Storage: the account, its firewall and the share ─────────────────────

resource "azurerm_storage_account" "files" {
  name                            = "${var.name_prefix}files"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  public_network_access_enabled   = true
  tags                            = var.tags

  # "Enabled from selected virtual networks": only snet-vms gets in.
  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    virtual_network_subnet_ids = [azurerm_subnet.vms.id]
  }

  # Soft delete for shares, so a deleted share can be brought back.
  share_properties {
    retention_policy {
      days = 7
    }
  }
}

resource "azurerm_storage_share" "share" {
  name               = "labshare"
  storage_account_id = azurerm_storage_account.files.id
  quota              = 5
  enabled_protocol   = "SMB"
  access_tier        = "TransactionOptimized"
}

# ── The VM ────────────────────────────────────────────────────────────────

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm-files"
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
  name                            = "vm-files"
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

  # Mounts the share at first boot. The rendered text holds the storage key,
  # so it is sensitive: plans and the live log show it as (sensitive value).
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    account = azurerm_storage_account.files.name
    host    = azurerm_storage_account.files.primary_file_host
    share   = azurerm_storage_share.share.name
    key     = azurerm_storage_account.files.primary_access_key
  }))
}
