# main.tf
#
# Plain English: two small Linux VMs in different availability zones, a data
# disk and a VM extension. vm-zone1 sits in zone 1 and vm-zone2 in zone 2 of
# the region, each a Standard_B1s Ubuntu 24.04 VM with no public IP. A 4 GiB
# Standard SSD data disk, made in zone 1 (a zonal disk can only attach to a
# VM in its own zone), is attached to vm-zone1 at LUN 0, blank and
# unformatted, for you to partition and mount. A Custom Script extension on
# each VM writes the VM's name to a page and serves it on port 80 with
# python3 (already on Ubuntu): nothing is installed or downloaded. Reach the
# VMs over the tunnel when peered, or through the portal's serial console or
# Run command.

locals {
  # The first /20 of the slot; the VM subnet is its first /24.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  vms_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)

  # A systemd unit that serves /srv/www on port 80, so the page survives a
  # reboot. printf turns each \n into a line break on the VM.
  web_unit = join("\\n", [
    "[Unit]",
    "Description=Lab web page (the VM name) on port 80",
    "After=network-online.target",
    "",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])

  # What the Custom Script extension runs, as root, once.
  serve_web = join(" && ", [
    "mkdir -p /srv/www",
    "hostname > /srv/www/index.html",
    "printf '${local.web_unit}' > /etc/systemd/system/lab-web.service",
    "systemctl daemon-reload",
    "systemctl enable --now lab-web.service",
  ])
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
  # No public IPs; the extension needs no internet, but Azure's default
  # outbound access is kept on (as lab 7) so apt works if you try it.
  default_outbound_access_enabled = true
}

# ── vm-zone1, in availability zone 1 ─────────────────────────────────────

resource "azurerm_network_interface" "zone1" {
  name                = "nic-vm-zone1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.vms.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "zone1" {
  name                            = "vm-zone1"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  zone                            = "1"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.zone1.id]
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

# ── vm-zone2, in availability zone 2 ─────────────────────────────────────

resource "azurerm_network_interface" "zone2" {
  name                = "nic-vm-zone2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.vms.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "zone2" {
  name                            = "vm-zone2"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  zone                            = "2"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.zone2.id]
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

  boot_diagnostics {}
}

# ── The data disk: zonal, so it must be in vm-zone1's zone ────────────────

resource "azurerm_managed_disk" "data" {
  name                 = "disk-zone1-data"
  resource_group_name  = azurerm_resource_group.lab.name
  location             = azurerm_resource_group.lab.location
  storage_account_type = "StandardSSD_LRS"
  create_option        = "Empty"
  disk_size_gb         = 4
  zone                 = "1"
  tags                 = var.tags
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.zone1.id
  lun                = 0
  caching            = "ReadWrite"
}

# ── The Custom Script extension: a page with the VM's name on port 80 ────

resource "azurerm_virtual_machine_extension" "web_zone1" {
  name                       = "serve-web"
  virtual_machine_id         = azurerm_linux_virtual_machine.zone1.id
  publisher                  = "Microsoft.Azure.Extensions"
  type                       = "CustomScript"
  type_handler_version       = "2.1"
  auto_upgrade_minor_version = true
  settings                   = jsonencode({ commandToExecute = local.serve_web })
  tags                       = var.tags
}

resource "azurerm_virtual_machine_extension" "web_zone2" {
  name                       = "serve-web"
  virtual_machine_id         = azurerm_linux_virtual_machine.zone2.id
  publisher                  = "Microsoft.Azure.Extensions"
  type                       = "CustomScript"
  type_handler_version       = "2.1"
  auto_upgrade_minor_version = true
  settings                   = jsonencode({ commandToExecute = local.serve_web })
  tags                       = var.tags
}
