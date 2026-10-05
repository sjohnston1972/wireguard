# main.tf
#
# Plain English: a break-fix lab. vm-app should reach vm-db's service on
# port 8080, and it cannot. Two faults, both deliberate, both realistic:
#
#   1. nsg-db, on snet-db, has a rule called "allow-monitoring" that in fact
#      DENIES TCP 8080 from the VNet, at priority 100: ahead of the real
#      allow (allow-app-8080, priority 200), so the allow never matters.
#   2. rt-app, on snet-app, sends snet-db's prefix to a virtual appliance at
#      fw_ip: an address in a /24 of the VNet that no subnet uses, so nothing
#      holds it and the packets are dropped (a firewall that was removed and
#      its route left behind).
#
# Both VMs carry the Network Watcher agent, so connection troubleshoot works
# from either. Network Watcher itself is Azure's own (NetworkWatcher_<region>
# in NetworkWatcherRG, made by Azure when the first VNet in a region is);
# this lab makes no Network Watcher resource and never touches that group.
# vm-db serves its name on 8080 and vm-app on 80, with python3's built-in
# web server. The readme's "What was broken" has the answer.

locals {
  # The first /20 of the slot: snet-app is its first /24, snet-db the second.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  app_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
  db_cidr   = cidrsubnet(local.vnet_cidr, 4, 1)

  # Where the old firewall was: the VNet's last /24, which no subnet uses.
  fw_ip = cidrhost(cidrsubnet(local.vnet_cidr, 4, 15), 4)
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

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.app_cidr]
}

resource "azurerm_subnet" "db" {
  name                 = "snet-db"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.db_cidr]
}

# ── nsg-db: fault 1, a deny named like an allow ──────────────────────────

resource "azurerm_network_security_group" "db" {
  name                = "nsg-db"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "db_monitoring" {
  name                        = "allow-monitoring"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.db.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "8080"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "db_from_app" {
  name                        = "allow-app-8080"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.db.name
  priority                    = 200
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "8080"
  source_address_prefix       = local.app_cidr
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "db_ssh" {
  name                        = "allow-ssh-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.db.name
  priority                    = 300
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "db" {
  subnet_id                 = azurerm_subnet.db.id
  network_security_group_id = azurerm_network_security_group.db.id
}

# ── rt-app: fault 2, a route to an appliance that is not there ───────────

resource "azurerm_route_table" "app" {
  name                = "rt-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_route" "app_to_db" {
  name                   = "to-db-via-firewall"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.app.name
  address_prefix         = local.db_cidr
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = local.fw_ip
}

resource "azurerm_subnet_route_table_association" "app" {
  subnet_id      = azurerm_subnet.app.id
  route_table_id = azurerm_route_table.app.id
}

# ── The VMs: vm-app (port 80) and vm-db (port 8080) ──────────────────────

resource "azurerm_network_interface" "app" {
  name                = "nic-vm-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "app" {
  name                            = "vm-app"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.app.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))
}

resource "azurerm_network_interface" "db" {
  name                = "nic-vm-db"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.db.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "db" {
  name                            = "vm-db"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.db.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 8080 }))
}

# ── The Network Watcher agent on both VMs (connection troubleshoot) ──────

resource "azurerm_virtual_machine_extension" "nw_app" {
  name                       = "AzureNetworkWatcherExtension"
  virtual_machine_id         = azurerm_linux_virtual_machine.app.id
  publisher                  = "Microsoft.Azure.NetworkWatcher"
  type                       = "NetworkWatcherAgentLinux"
  type_handler_version       = "1.4"
  auto_upgrade_minor_version = true
  tags                       = var.tags
}

resource "azurerm_virtual_machine_extension" "nw_db" {
  name                       = "AzureNetworkWatcherExtension"
  virtual_machine_id         = azurerm_linux_virtual_machine.db.id
  publisher                  = "Microsoft.Azure.NetworkWatcher"
  type                       = "NetworkWatcherAgentLinux"
  type_handler_version       = "1.4"
  auto_upgrade_minor_version = true
  tags                       = var.tags
}
