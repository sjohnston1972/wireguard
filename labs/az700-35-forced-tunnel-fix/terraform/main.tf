# main.tf
#
# Plain English: a break-fix lab. A hub and a spoke, peered both ways with
# forwarded traffic allowed. The spoke forces ALL its internet traffic
# through a network virtual appliance (NVA) in the hub: its route table
# sends 0.0.0.0/0 to vm-nva, and its subnet has default outbound access off,
# so that route is its only way out. vm-nva is meant to forward that traffic
# and translate it (SNAT) to its own address on the way out.
#
# It does not. This is deliberate: the lab's three faults are
#   - vm-nva's network interface has IP forwarding OFF, so Azure never
#     hands it packets addressed to other machines
#   - vm-nva's kernel has net.ipv4.ip_forward = 0 (nva-init.yaml.tftpl)
#   - nothing on vm-nva masquerades the spoke's addresses
# The readme's "What was broken" explains them and the fix.
#
# vm-nva itself has default outbound access, so once fixed it can carry the
# spoke's traffic out (and install anything it needs).

locals {
  # Two /20s of the slot: the hub and the spoke.
  hub_cidr   = cidrsubnet(var.address_space, 2, 0)
  spoke_cidr = cidrsubnet(var.address_space, 2, 1)

  # One /24 in each, and the NVA's fixed address (the route names it).
  nva_subnet = cidrsubnet(local.hub_cidr, 4, 0)
  app_subnet = cidrsubnet(local.spoke_cidr, 4, 0)
  nva_ip     = cidrhost(local.nva_subnet, 4)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The hub and the spoke, peered both ways ──────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "nva" {
  name                 = "snet-nva"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.nva_subnet]

  # The NVA's own way out to the internet (ruling 37).
  default_outbound_access_enabled = true
}

resource "azurerm_virtual_network" "spoke" {
  name                = "vnet-spoke"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.spoke_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.spoke.name
  address_prefixes     = [local.app_subnet]

  # Forced through the appliance: no way out of its own (ruling 37).
  default_outbound_access_enabled = false
}

resource "azurerm_virtual_network_peering" "hub_to_spoke" {
  name                         = "peer-hub-to-spoke"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.spoke.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

resource "azurerm_virtual_network_peering" "spoke_to_hub" {
  name                         = "peer-spoke-to-hub"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.spoke.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}

# ── Forced tunnelling: the spoke's default route goes to vm-nva ──────────

resource "azurerm_route_table" "spoke" {
  name                = "rt-spoke"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_route" "default" {
  name                   = "default-via-nva"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke.name
  address_prefix         = "0.0.0.0/0"
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = local.nva_ip
}

resource "azurerm_subnet_route_table_association" "app" {
  subnet_id      = azurerm_subnet.app.id
  route_table_id = azurerm_route_table.spoke.id
}

# ── vm-nva: the appliance (faults 1 to 3) ────────────────────────────────

resource "azurerm_network_interface" "nva" {
  name                = "nic-vm-nva"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  # Fault 1, on purpose.
  ip_forwarding_enabled = false

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.nva.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.nva_ip
  }
}

resource "azurerm_linux_virtual_machine" "nva" {
  name                            = "vm-nva"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.nva.id]
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

  # Fault 2 (kernel forwarding off); fault 3 is what it leaves out.
  custom_data = base64encode(templatefile("${path.module}/nva-init.yaml.tftpl", {}))
}

# ── vm-app in the spoke ──────────────────────────────────────────────────

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

  boot_diagnostics {}
}
