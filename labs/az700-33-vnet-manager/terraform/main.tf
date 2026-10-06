# main.tf
#
# Plain English: a hub and two spokes, three VNets from the first three /20s
# of the slot, with NO peerings of their own. Azure Virtual Network Manager
# (AVNM) makes them, and applies security admin rules that sit above every
# NSG:
#
#   network group ng-spokes    the two spokes, as STATIC members (by reference)
#   connectivity cc-hub-spoke  hub-and-spoke: AVNM peers each spoke with
#                              vnet-hub, and connects the spokes directly
#                              to each other (DirectlyConnected)
#   security admin sac-lab     on ng-spokes: deny SSH from the internet;
#                              always allow SSH from the hub /20
#   two deployments            each configuration committed in the lab's region
#
# Scope exception S1 (spec §17, ruling 47, approved by Steven 2026-10-05):
# a network manager's scope can only be a subscription or a management group,
# so this one is scoped to the current subscription. It still lives in
# rg-lab-<id>, and what it touches is only what its groups hold: two static
# members, both this lab's spokes. The scope check refuses anything wider.
#
# Destroy un-deploys first (the deployments depend on everything else), and
# the pipeline's unblock deploys "None" if anything is left committed.
#
# Each spoke's NSG denies SSH from the hub. The AlwaysAllow admin rule wins
# over that deny, so the NSG never gets the chance to say no. Nothing allows
# SSH from the internet anywhere (spec §3.9); the Deny admin rule says so first.

locals {
  # Three /20s of the slot: the hub and two spokes.
  hub_cidr    = cidrsubnet(var.address_space, 2, 0)
  spoke1_cidr = cidrsubnet(var.address_space, 2, 1)
  spoke2_cidr = cidrsubnet(var.address_space, 2, 2)

  # One /24 in each.
  shared_subnet = cidrsubnet(local.hub_cidr, 4, 0)
  spoke1_subnet = cidrsubnet(local.spoke1_cidr, 4, 0)
  spoke2_subnet = cidrsubnet(local.spoke2_cidr, 4, 0)
}

# The subscription the pipeline runs in: the network manager's scope (S1).
data "azurerm_subscription" "current" {}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Three VNets, unpeered: AVNM does the peering ─────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "shared" {
  name                 = "snet-shared"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.shared_subnet]

  # Azure's long-standing default, said explicitly (ruling 37).
  default_outbound_access_enabled = true
}

resource "azurerm_virtual_network" "spoke1" {
  name                = "vnet-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.spoke1_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "spoke1" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.spoke1.name
  address_prefixes     = [local.spoke1_subnet]

  default_outbound_access_enabled = true
}

resource "azurerm_virtual_network" "spoke2" {
  name                = "vnet-spoke2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.spoke2_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "spoke2" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.spoke2.name
  address_prefixes     = [local.spoke2_subnet]

  default_outbound_access_enabled = true
}

# ── Spoke NSGs: deny SSH from the hub (the admin rule overrides it) ──────

resource "azurerm_network_security_group" "spoke1" {
  name                = "nsg-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "spoke1_deny_hub_ssh" {
  name                        = "deny-ssh-from-hub"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.spoke1.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "Tcp"
  source_address_prefix       = local.hub_cidr
  source_port_range           = "*"
  destination_address_prefix  = "*"
  destination_port_range      = "22"
}

resource "azurerm_subnet_network_security_group_association" "spoke1" {
  subnet_id                 = azurerm_subnet.spoke1.id
  network_security_group_id = azurerm_network_security_group.spoke1.id
}

resource "azurerm_network_security_group" "spoke2" {
  name                = "nsg-spoke2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "spoke2_deny_hub_ssh" {
  name                        = "deny-ssh-from-hub"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.spoke2.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "Tcp"
  source_address_prefix       = local.hub_cidr
  source_port_range           = "*"
  destination_address_prefix  = "*"
  destination_port_range      = "22"
}

resource "azurerm_subnet_network_security_group_association" "spoke2" {
  subnet_id                 = azurerm_subnet.spoke2.id
  network_security_group_id = azurerm_network_security_group.spoke2.id
}

# ── The network manager (S1: scoped to the current subscription) ─────────

resource "azurerm_network_manager" "avnm" {
  name                = "avnm-${var.name_prefix}"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  scope_accesses      = ["Connectivity", "SecurityAdmin"]
  description         = "Lab 33: manages only this lab's spokes (static members)."
  tags                = var.tags

  scope {
    subscription_ids = [data.azurerm_subscription.current.id]
  }
}

# A group of VNets, filled only by the static members below. Dynamic
# membership would need an Azure Policy at the subscription: never here.
resource "azurerm_network_manager_network_group" "spokes" {
  name               = "ng-spokes"
  network_manager_id = azurerm_network_manager.avnm.id
  description        = "The lab's two spokes."
}

resource "azurerm_network_manager_static_member" "spoke1" {
  name                      = "sm-spoke1"
  network_group_id          = azurerm_network_manager_network_group.spokes.id
  target_virtual_network_id = azurerm_virtual_network.spoke1.id
}

resource "azurerm_network_manager_static_member" "spoke2" {
  name                      = "sm-spoke2"
  network_group_id          = azurerm_network_manager_network_group.spokes.id
  target_virtual_network_id = azurerm_virtual_network.spoke2.id
}

# ── Connectivity: hub-and-spoke, spokes directly connected ──────────────

resource "azurerm_network_manager_connectivity_configuration" "hub_spoke" {
  name                  = "cc-hub-spoke"
  network_manager_id    = azurerm_network_manager.avnm.id
  connectivity_topology = "HubAndSpoke"
  global_mesh_enabled   = false

  applies_to_group {
    group_connectivity = "DirectlyConnected"
    network_group_id   = azurerm_network_manager_network_group.spokes.id
    use_hub_gateway    = false
  }

  hub {
    resource_id   = azurerm_virtual_network.hub.id
    resource_type = "Microsoft.Network/virtualNetworks"
  }
}

# ── Security admin rules on ng-spokes ────────────────────────────────────

resource "azurerm_network_manager_security_admin_configuration" "lab" {
  name               = "sac-lab"
  network_manager_id = azurerm_network_manager.avnm.id
}

resource "azurerm_network_manager_admin_rule_collection" "spokes" {
  name                            = "rc-spokes"
  security_admin_configuration_id = azurerm_network_manager_security_admin_configuration.lab.id
  network_group_ids               = [azurerm_network_manager_network_group.spokes.id]
}

# Evaluated before any NSG: SSH from the internet never reaches a spoke.
resource "azurerm_network_manager_admin_rule" "deny_ssh" {
  name                     = "deny-ssh-internet"
  admin_rule_collection_id = azurerm_network_manager_admin_rule_collection.spokes.id
  action                   = "Deny"
  direction                = "Inbound"
  priority                 = 100
  protocol                 = "Tcp"
  destination_port_ranges  = ["22"]

  source {
    address_prefix_type = "ServiceTag"
    address_prefix      = "Internet"
  }
}

# AlwaysAllow ends evaluation: the spoke NSGs' deny from the hub never applies.
resource "azurerm_network_manager_admin_rule" "allow_hub_ssh" {
  name                     = "always-allow-hub-ssh"
  admin_rule_collection_id = azurerm_network_manager_admin_rule_collection.spokes.id
  action                   = "AlwaysAllow"
  direction                = "Inbound"
  priority                 = 90
  protocol                 = "Tcp"
  destination_port_ranges  = ["22"]

  source {
    address_prefix_type = "IPPrefix"
    address_prefix      = local.hub_cidr
  }
}

# ── Commit both configurations in the lab's region ───────────────────────
# Nothing takes effect until it is deployed. Each deployment waits for what
# its configuration points at, and destroy removes it first (un-deploying).

resource "azurerm_network_manager_deployment" "connectivity" {
  network_manager_id = azurerm_network_manager.avnm.id
  location           = azurerm_resource_group.lab.location
  scope_access       = "Connectivity"
  configuration_ids  = [azurerm_network_manager_connectivity_configuration.hub_spoke.id]

  # azurerm waits up to 24 hours by default; no job runs that long.
  timeouts {
    create = "30m"
    delete = "30m"
  }

  depends_on = [azurerm_network_manager_static_member.spoke1, azurerm_network_manager_static_member.spoke2]
}

resource "azurerm_network_manager_deployment" "security" {
  network_manager_id = azurerm_network_manager.avnm.id
  location           = azurerm_resource_group.lab.location
  scope_access       = "SecurityAdmin"
  configuration_ids  = [azurerm_network_manager_security_admin_configuration.lab.id]

  timeouts {
    create = "30m"
    delete = "30m"
  }

  depends_on = [azurerm_network_manager_admin_rule.deny_ssh, azurerm_network_manager_admin_rule.allow_hub_ssh, azurerm_network_manager_static_member.spoke1, azurerm_network_manager_static_member.spoke2]
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
