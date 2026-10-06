# main.tf
#
# Plain English: hub and spoke with Azure Firewall in the middle.
#
#   vnet-hub (the first /20 of the slot) holds afw-hub, an Azure Firewall on
#   the Basic tier (never Standard or Premium here). Basic needs two subnets,
#   AzureFirewallSubnet for traffic and AzureFirewallManagementSubnet for
#   Azure's own management of it (each a /26), and a Standard public IP for
#   each.
#
#   The rules live in two Firewall Manager policies, both Basic. fwp-base is
#   the organisation's parent policy: network rules letting the spokes reach
#   each other on SSH and ping. fwp-hub inherits it and adds application
#   rules: the spokes may browse *.ubuntu.com and www.microsoft.com on 80 and
#   443, and nothing else. The firewall uses fwp-hub.
#
#   vnet-spoke1 and vnet-spoke2 (the second and third /20s) are each peered
#   with the hub (forwarded traffic allowed) but not with each other. Each
#   spoke's route table sends 0.0.0.0/0 and the other spoke's /20 to the
#   firewall's private IP, and the spoke subnets have no default outbound
#   access: everything leaving a spoke goes through the firewall.
#
#   The firewall's application and network rule logs go to log-hub, a
#   Log Analytics workspace capped at 50 MB a day, in resource-specific
#   tables (AZFWApplicationRule, AZFWNetworkRule, ...).
#
# Destroy order is Terraform's own: the firewall goes before its policies
# (it names fwp-hub) and the rule collection groups, fwp-hub before fwp-base
# (it inherits it).

locals {
  # Three /20s of the slot: the hub and the two spokes.
  hub_cidr    = cidrsubnet(var.address_space, 2, 0)
  spoke1_cidr = cidrsubnet(var.address_space, 2, 1)
  spoke2_cidr = cidrsubnet(var.address_space, 2, 2)
  # The firewall's two /26s, and one /24 in each spoke.
  firewall_cidr            = cidrsubnet(local.hub_cidr, 6, 0)
  firewall_management_cidr = cidrsubnet(local.hub_cidr, 6, 1)
  spoke1_subnet            = cidrsubnet(local.spoke1_cidr, 4, 0)
  spoke2_subnet            = cidrsubnet(local.spoke2_cidr, 4, 0)
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

# The firewall's subnets keep Azure's long-standing default outbound setting:
# the firewall uses its own public IPs, so the setting changes nothing for it.
resource "azurerm_subnet" "firewall" {
  name                            = "AzureFirewallSubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.firewall_cidr]
  default_outbound_access_enabled = true
}

resource "azurerm_subnet" "firewall_management" {
  name                            = "AzureFirewallManagementSubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.firewall_management_cidr]
  default_outbound_access_enabled = true
}

# The spokes' subnets are private (ruling 37): their only way out is the
# firewall, through the route tables below.
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

# ── Peerings: each spoke with the hub, both ways ─────────────────────────

# Forwarded traffic is allowed on all four: packets the firewall passes on
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

# ── Firewall Manager policies: fwp-base (parent) and fwp-hub (child) ─────

resource "azurerm_firewall_policy" "base" {
  name                = "fwp-base"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Basic"
  tags                = var.tags
}

resource "azurerm_firewall_policy" "hub" {
  name                = "fwp-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Basic"
  base_policy_id      = azurerm_firewall_policy.base.id
  tags                = var.tags
}

# The parent's rules: spoke to spoke, SSH and ping. Every child inherits them,
# ahead of its own network rules.
resource "azurerm_firewall_policy_rule_collection_group" "base" {
  name               = "rcg-base"
  firewall_policy_id = azurerm_firewall_policy.base.id
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
}

# The child's own rules: which websites the spokes may reach.
resource "azurerm_firewall_policy_rule_collection_group" "hub" {
  name               = "rcg-hub"
  firewall_policy_id = azurerm_firewall_policy.hub.id
  priority           = 200

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

    rule {
      name              = "microsoft"
      source_addresses  = [local.spoke1_cidr, local.spoke2_cidr]
      destination_fqdns = ["www.microsoft.com"]

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

  # One change to the policy hierarchy at a time.
  depends_on = [azurerm_firewall_policy_rule_collection_group.base]
}

# ── The firewall: afw-hub (Basic) ────────────────────────────────────────

resource "azurerm_public_ip" "firewall" {
  name                = "pip-afw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_public_ip" "firewall_management" {
  name                = "pip-afw-hub-mgmt"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_firewall" "hub" {
  name                = "afw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku_name            = "AZFW_VNet"
  sku_tier            = "Basic"
  firewall_policy_id  = azurerm_firewall_policy.hub.id
  tags                = var.tags

  ip_configuration {
    name                 = "ipconfig-data"
    subnet_id            = azurerm_subnet.firewall.id
    public_ip_address_id = azurerm_public_ip.firewall.id
  }

  # Basic always has a management configuration: Azure's own traffic to the
  # firewall, apart from yours.
  management_ip_configuration {
    name                 = "ipconfig-mgmt"
    subnet_id            = azurerm_subnet.firewall_management.id
    public_ip_address_id = azurerm_public_ip.firewall_management.id
  }

  # The policy's rules are in place before the firewall starts, and on destroy
  # the firewall goes first.
  depends_on = [
    azurerm_firewall_policy_rule_collection_group.base,
    azurerm_firewall_policy_rule_collection_group.hub,
  ]
}

# ── Routes: everything leaving a spoke goes to the firewall ──────────────

resource "azurerm_route_table" "spoke1" {
  name                = "rt-spoke1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_route" "spoke1_default" {
  name                   = "default-via-firewall"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke1.name
  address_prefix         = "0.0.0.0/0"
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = azurerm_firewall.hub.ip_configuration[0].private_ip_address
}

resource "azurerm_route" "spoke1_to_spoke2" {
  name                   = "to-spoke2-via-firewall"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke1.name
  address_prefix         = local.spoke2_cidr
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = azurerm_firewall.hub.ip_configuration[0].private_ip_address
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

resource "azurerm_route" "spoke2_default" {
  name                   = "default-via-firewall"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke2.name
  address_prefix         = "0.0.0.0/0"
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = azurerm_firewall.hub.ip_configuration[0].private_ip_address
}

resource "azurerm_route" "spoke2_to_spoke1" {
  name                   = "to-spoke1-via-firewall"
  resource_group_name    = azurerm_resource_group.lab.name
  route_table_name       = azurerm_route_table.spoke2.name
  address_prefix         = local.spoke1_cidr
  next_hop_type          = "VirtualAppliance"
  next_hop_in_ip_address = azurerm_firewall.hub.ip_configuration[0].private_ip_address
}

resource "azurerm_subnet_route_table_association" "spoke2" {
  subnet_id      = azurerm_subnet.spoke2.id
  route_table_id = azurerm_route_table.spoke2.id
}

# ── Logs: log-hub, capped, resource-specific tables ──────────────────────

resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  # 30 days are included in the price (and the least PerGB2018 keeps).
  retention_in_days = 30
  # At most 50 MB a day is ingested; after that Azure drops data until the
  # next day (UTC). A session sends a few MB.
  daily_quota_gb = 0.05
  tags           = var.tags
}

resource "azurerm_monitor_diagnostic_setting" "firewall" {
  name                           = "diag-afw-hub"
  target_resource_id             = azurerm_firewall.hub.id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.lab.id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "AZFWApplicationRule"
  }

  enabled_log {
    category = "AZFWNetworkRule"
  }

  enabled_log {
    category = "AZFWNatRule"
  }

  enabled_log {
    category = "AZFWThreatIntel"
  }
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
