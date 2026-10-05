# main.tf
#
# Plain English: one VNet cut into two subnets, each behind its own network
# security group (NSG), with application security groups (ASGs) naming the
# two tiers. vm-web serves port 80 and vm-app serves port 8080, both with
# python3's built-in web server and no public IP.
#
#   nsg-web  lets the VNet in on ssh (22) and http (80), then denies the
#            rest of the VNet. "VirtualNetwork" includes peered address
#            space, so a tunnel client gets in too while the lab is peered.
#   nsg-app  lets asg-web in on 8080 and denies everything else from the
#            VNet, the tunnel included. Reach vm-app through the portal's
#            serial console or Run command.
#
# Both NSGs leave Azure's default rules in place underneath: the custom deny
# at 4000 comes before AllowVnetInBound (65000), which is the point.

locals {
  # The first /20 of the slot; one /24 per tier.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  web_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
  app_cidr  = cidrsubnet(local.vnet_cidr, 4, 1)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network: the VNet and its two subnets ────────────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.web_cidr]
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.app_cidr]
}

# ── Application security groups: the tiers, by role not by address ───────

resource "azurerm_application_security_group" "web" {
  name                = "asg-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_application_security_group" "app" {
  name                = "asg-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# ── nsg-web: ssh and http from the VNet, nothing else ────────────────────

resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "web_ssh" {
  name                        = "allow-ssh-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "web_http" {
  name                        = "allow-http-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "web_deny_vnet" {
  name                        = "deny-other-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.web.id
}

# ── nsg-app: only asg-web, only on 8080 ──────────────────────────────────

resource "azurerm_network_security_group" "app" {
  name                = "nsg-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "app_from_web" {
  name                                       = "allow-asg-web-to-asg-app-8080"
  resource_group_name                        = azurerm_resource_group.lab.name
  network_security_group_name                = azurerm_network_security_group.app.name
  priority                                   = 100
  direction                                  = "Inbound"
  access                                     = "Allow"
  protocol                                   = "Tcp"
  source_port_range                          = "*"
  destination_port_range                     = "8080"
  source_application_security_group_ids      = [azurerm_application_security_group.web.id]
  destination_application_security_group_ids = [azurerm_application_security_group.app.id]
}

resource "azurerm_network_security_rule" "app_deny_vnet" {
  name                        = "deny-other-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.app.name
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# ── The VMs: vm-web (port 80) and vm-app (port 8080) ─────────────────────

resource "azurerm_network_interface" "web" {
  name                = "nic-vm-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "web" {
  name                            = "vm-web"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web.id]
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

resource "azurerm_network_interface_application_security_group_association" "web" {
  network_interface_id          = azurerm_network_interface.web.id
  application_security_group_id = azurerm_application_security_group.web.id
}

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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 8080 }))
}

resource "azurerm_network_interface_application_security_group_association" "app" {
  network_interface_id          = azurerm_network_interface.app.id
  application_security_group_id = azurerm_application_security_group.app.id
}
