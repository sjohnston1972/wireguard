# main.tf
#
# Plain English: a Virtual WAN with a secured hub.
#
#   vwan-lab is a Standard virtual WAN (Basic has no firewall, no routing
#   intent and no VNet-to-VNet transit through the hub). vhub-lab is its one
#   hub, with a /23 address prefix: the first /23 of the slot's fourth /20.
#   Azure runs the hub's routers in it; nothing else may use it.
#
#   afw-vhub is an Azure Firewall on the Basic tier inside the hub (AZFW_Hub),
#   which makes it a secured hub. Azure gives it one public IP of its own. Its
#   Basic policy, fwp-vhub, lets the spokes reach each other on SSH and ping,
#   and reach *.ubuntu.com on 80 and 443; anything else is denied.
#
#   Routing intent sends both private traffic (the RFC 1918 ranges) and
#   internet traffic (0.0.0.0/0) through the firewall. vnet-spoke1 and
#   vnet-spoke2 (the first and second /20s) are connected to the hub with
#   internet security on, so they learn the 0.0.0.0/0 route; their subnets
#   have no default outbound access, so the firewall is their only way out.
#
# Peering is off: a virtual hub owns its connections, and the pipeline's
# peering to the gateway's VNet cannot join it. The VMs are reached through
# the portal's serial console or Run command.
#
# The hub takes about 30 minutes to create, the firewall 10 more. Order, both
# ways: hub, firewall, then the two connections, then routing intent; on
# destroy routing intent goes first, then the connections, the firewall and
# its policy, then the hub and the WAN (as unblock 7d does by hand).

locals {
  # Two /20s for the spokes, and the hub's /23 from the fourth /20.
  spoke1_cidr = cidrsubnet(var.address_space, 2, 0)
  spoke2_cidr = cidrsubnet(var.address_space, 2, 1)
  hub_prefix  = cidrsubnet(cidrsubnet(var.address_space, 2, 3), 3, 0)
  # One /24 in each spoke.
  spoke1_subnet = cidrsubnet(local.spoke1_cidr, 4, 0)
  spoke2_subnet = cidrsubnet(local.spoke2_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The WAN and its hub ──────────────────────────────────────────────────

resource "azurerm_virtual_wan" "lab" {
  name                = "vwan-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  type                = "Standard"
  tags                = var.tags
}

resource "azurerm_virtual_hub" "lab" {
  name                = "vhub-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  virtual_wan_id      = azurerm_virtual_wan.lab.id
  address_prefix      = local.hub_prefix
  sku                 = "Standard"
  tags                = var.tags
}

# ── The hub's firewall policy and its rules ──────────────────────────────

resource "azurerm_firewall_policy" "hub" {
  name                = "fwp-vhub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Basic"
  tags                = var.tags
}

resource "azurerm_firewall_policy_rule_collection_group" "hub" {
  name               = "rcg-vhub"
  firewall_policy_id = azurerm_firewall_policy.hub.id
  priority           = 100

  network_rule_collection {
    name     = "allow-spoke-to-spoke"
    priority = 100
    action   = "Allow"

    rule {
      name                  = "ssh"
      protocols             = ["TCP"]
      source_addresses      = [local.spoke1_cidr, local.spoke2_cidr]
      destination_addresses = [local.spoke1_cidr, local.spoke2_cidr]
      destination_ports     = ["22"]
    }

    rule {
      name                  = "ping"
      protocols             = ["ICMP"]
      source_addresses      = [local.spoke1_cidr, local.spoke2_cidr]
      destination_addresses = [local.spoke1_cidr, local.spoke2_cidr]
      destination_ports     = ["*"]
    }
  }

  application_rule_collection {
    name     = "allow-web"
    priority = 200
    action   = "Allow"

    rule {
      name              = "ubuntu-mirrors"
      source_addresses  = [local.spoke1_cidr, local.spoke2_cidr]
      destination_fqdns = ["*.ubuntu.com"]

      protocols {
        type = "Http"
        port = 80
      }

      protocols {
        type = "Https"
        port = 443
      }
    }
  }
}

# ── The secured hub's firewall: afw-vhub (Basic) ─────────────────────────

resource "azurerm_firewall" "hub" {
  name                = "afw-vhub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku_name            = "AZFW_Hub"
  sku_tier            = "Basic"
  firewall_policy_id  = azurerm_firewall_policy.hub.id
  tags                = var.tags

  # No subnet and no public IP resource: the firewall lives in the hub, and
  # Azure gives it one public IP of its own.
  virtual_hub {
    virtual_hub_id  = azurerm_virtual_hub.lab.id
    public_ip_count = 1
  }

  depends_on = [azurerm_firewall_policy_rule_collection_group.hub]
}

# ── The spokes, connected to the hub ─────────────────────────────────────

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

# Private subnets (ruling 37): the hub firewall is the only way out.
resource "azurerm_subnet" "spoke1" {
  name                            = "snet-workload"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.spoke1.name
  address_prefixes                = [local.spoke1_subnet]
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "spoke2" {
  name                            = "snet-workload"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.spoke2.name
  address_prefixes                = [local.spoke2_subnet]
  default_outbound_access_enabled = false
}

# Internet security on: the spoke learns the hub's 0.0.0.0/0 (routing intent's
# internet policy). The connections wait for the firewall, so the hub is
# changed one thing at a time.
resource "azurerm_virtual_hub_connection" "spoke1" {
  name                      = "conn-spoke1"
  virtual_hub_id            = azurerm_virtual_hub.lab.id
  remote_virtual_network_id = azurerm_virtual_network.spoke1.id
  internet_security_enabled = true

  depends_on = [azurerm_firewall.hub]
}

resource "azurerm_virtual_hub_connection" "spoke2" {
  name                      = "conn-spoke2"
  virtual_hub_id            = azurerm_virtual_hub.lab.id
  remote_virtual_network_id = azurerm_virtual_network.spoke2.id
  internet_security_enabled = true

  depends_on = [azurerm_firewall.hub]
}

# ── Routing intent: private and internet traffic through the firewall ────

# Made last and destroyed first: with it gone, the connections and the
# firewall can go.
resource "azurerm_virtual_hub_routing_intent" "hub" {
  name           = "ri-vhub"
  virtual_hub_id = azurerm_virtual_hub.lab.id

  routing_policy {
    name         = "InternetTrafficPolicy"
    destinations = ["Internet"]
    next_hop     = azurerm_firewall.hub.id
  }

  routing_policy {
    name         = "PrivateTrafficPolicy"
    destinations = ["PrivateTraffic"]
    next_hop     = azurerm_firewall.hub.id
  }

  depends_on = [
    azurerm_virtual_hub_connection.spoke1,
    azurerm_virtual_hub_connection.spoke2,
  ]
}

# ── A VM in each spoke: vm-spoke1 and vm-spoke2 ──────────────────────────

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

  # Managed boot diagnostics: the portal's serial console works with no
  # storage account of our own.
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
