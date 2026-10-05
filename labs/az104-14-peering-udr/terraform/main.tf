# main.tf
#
# Plain English: a hub and two spokes, three VNets from the first three /20s
# of the slot. Each spoke is peered with the hub both ways; the spokes are
# not peered with each other, and peering is not transitive, so on their
# own they cannot talk. A small router VM in the hub (IP forwarding on its
# NIC and in the kernel) joins them: each spoke's route table sends the
# other spoke's /20 to the router. Nothing routes 0.0.0.0/0, so the VMs keep
# Azure's own way out. vm-spoke1 and vm-spoke2 serve their names on port 80.
#
# The pipeline peers only the hub with the gateway (peer_vnet_id), so a
# tunnel client reaches vm-router and, through it, the spokes; the spokes
# themselves are not reachable over the tunnel.

locals {
  # Three /20s of the slot: the hub and the two spokes.
  hub_cidr    = cidrsubnet(var.address_space, 2, 0)
  spoke1_cidr = cidrsubnet(var.address_space, 2, 1)
  spoke2_cidr = cidrsubnet(var.address_space, 2, 2)

  # One /24 in each.
  router_subnet = cidrsubnet(local.hub_cidr, 4, 0)
  spoke1_subnet = cidrsubnet(local.spoke1_cidr, 4, 0)
  spoke2_subnet = cidrsubnet(local.spoke2_cidr, 4, 0)

  # The router's fixed address: the routes name it, so it never changes.
  router_ip = cidrhost(local.router_subnet, 4)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The three VNets and their subnets ────────────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_virtual_network" "spoke1" {
  name                = "vnet-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.spoke1_cidr]
  tags                = var.tags
}

resource "azurerm_virtual_network" "spoke2" {
  name                = "vnet-spoke2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.spoke2_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "router" {
  name                 = "snet-router"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.router_subnet]
}

resource "azurerm_subnet" "spoke1" {
  name                 = "snet-workload"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.spoke1.name
  address_prefixes     = [local.spoke1_subnet]
}

resource "azurerm_subnet" "spoke2" {
  name                 = "snet-workload"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.spoke2.name
  address_prefixes     = [local.spoke2_subnet]
}

# ── Peerings: each spoke with the hub, both ways ─────────────────────────
# Forwarded traffic is allowed on all four: packets the router passes on
# keep the other spoke's source address, which a peering otherwise drops.

resource "azurerm_virtual_network_peering" "hub_to_spoke1" {
  name                         = "peer-hub-to-spoke1"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.spoke1.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

resource "azurerm_virtual_network_peering" "spoke1_to_hub" {
  name                         = "peer-spoke1-to-hub"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.spoke1.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

resource "azurerm_virtual_network_peering" "hub_to_spoke2" {
  name                         = "peer-hub-to-spoke2"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.spoke2.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

resource "azurerm_virtual_network_peering" "spoke2_to_hub" {
  name                         = "peer-spoke2-to-hub"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.spoke2.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

# ── The router (network virtual appliance) in the hub ────────────────────

resource "azurerm_network_interface" "router" {
  name                = "nic-vm-router"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  # Azure hands the NIC packets addressed to other machines only with this on.
  ip_forwarding_enabled = true

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.router.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.router_ip
  }
}

resource "azurerm_linux_virtual_machine" "router" {
  name                            = "vm-router"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.router.id]
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

  # Kernel forwarding on, ICMP redirects off (router-init.yaml.tftpl).
  custom_data = base64encode(templatefile("${path.module}/router-init.yaml.tftpl", {}))
}

# ── User-defined routes: each spoke reaches the other through the router ─

resource "azurerm_route_table" "spoke1" {
  name                = "rt-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_route" "spoke1_to_spoke2" {
  name                   = "to-spoke2-via-router"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke1.name
  address_prefix         = local.spoke2_cidr
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = local.router_ip
}

resource "azurerm_subnet_route_table_association" "spoke1" {
  subnet_id      = azurerm_subnet.spoke1.id
  route_table_id = azurerm_route_table.spoke1.id
}

resource "azurerm_route_table" "spoke2" {
  name                = "rt-spoke2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_route" "spoke2_to_spoke1" {
  name                   = "to-spoke1-via-router"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke2.name
  address_prefix         = local.spoke1_cidr
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = local.router_ip
}

resource "azurerm_subnet_route_table_association" "spoke2" {
  subnet_id      = azurerm_subnet.spoke2.id
  route_table_id = azurerm_route_table.spoke2.id
}

# ── A web server in each spoke (port 80) ─────────────────────────────────

resource "azurerm_network_interface" "spoke1" {
  name                = "nic-vm-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.spoke1.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "spoke1" {
  name                            = "vm-spoke1"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.spoke1.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))
}

resource "azurerm_network_interface" "spoke2" {
  name                = "nic-vm-spoke2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.spoke2.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "spoke2" {
  name                            = "vm-spoke2"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.spoke2.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))
}
