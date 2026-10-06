# main.tf
#
# Plain English: a site-to-site VPN between two VNets, one standing in for
# an on-premises site. Both are cut from the slot (vnet-azure the first /20,
# vnet-onprem the second) and are NOT peered: the only way between them is
# the IPsec tunnel.
#
#   Each VNet has a GatewaySubnet (/27) with a VpnGw1AZ gateway: route-based,
#   active-standby, Generation1, BGP on (ASN 65010 in Azure, 65020 "on-prem"),
#   on a Standard zone-redundant public IP. VpnGw1AZ, never Basic or the
#   non-AZ VpnGw1-5 (ruling 44): Basic has no BGP and no custom IPsec policy,
#   and new gateways need a Standard public IP.
#
#   Each side has a local network gateway describing the OTHER side: its
#   public IP, its /20, its BGP peering address and its ASN. Each gateway has
#   one IPsec connection to its local network gateway, with BGP over the
#   tunnel, the same random shared key and the same custom IPsec/IKE policy
#   (IKEv2 AES256/SHA256 DH group 14; IPsec GCMAES256 with PFS 14; SA lifetime
#   27,000 s). A connection comes up only when both ends agree.
#
# One VM in each VNet serves its name on port 80. Gateways take 30 to 45
# minutes to create (both are built at the same time) and about 20 to delete.
# Destroy order is Terraform's own: the connections go first (they name the
# gateways and local network gateways), then the local network gateways
# (they name the gateways' BGP addresses), then the gateways.

locals {
  # Two /20s of the slot: "Azure" and "on-prem".
  azure_cidr  = cidrsubnet(var.address_space, 2, 0)
  onprem_cidr = cidrsubnet(var.address_space, 2, 1)
  # In each, a /27 GatewaySubnet (the first) and a /24 for the VM (the second /24).
  azure_gateway_cidr  = cidrsubnet(local.azure_cidr, 7, 0)
  azure_app_cidr      = cidrsubnet(local.azure_cidr, 4, 1)
  onprem_gateway_cidr = cidrsubnet(local.onprem_cidr, 7, 0)
  onprem_app_cidr     = cidrsubnet(local.onprem_cidr, 4, 1)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The two VNets ────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "azure" {
  name                = "vnet-azure"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.azure_cidr]
  tags                = var.tags
}

resource "azurerm_virtual_network" "onprem" {
  name                = "vnet-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.onprem_cidr]
  tags                = var.tags
}

# A gateway needs a subnet named exactly GatewaySubnet, /27 or larger. It keeps
# Azure's long-standing default outbound setting: the gateway uses its own
# public IP, so the setting changes nothing for it.
resource "azurerm_subnet" "azure_gateway" {
  name                            = "GatewaySubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.azure.name
  address_prefixes                = [local.azure_gateway_cidr]
  default_outbound_access_enabled = true
}

resource "azurerm_subnet" "onprem_gateway" {
  name                            = "GatewaySubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.onprem.name
  address_prefixes                = [local.onprem_gateway_cidr]
  default_outbound_access_enabled = true
}

# The VMs' subnets keep default outbound access, so you can apt install a
# tool (traceroute, mtr) while you explore.
resource "azurerm_subnet" "azure_app" {
  name                            = "snet-app"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.azure.name
  address_prefixes                = [local.azure_app_cidr]
  default_outbound_access_enabled = true
}

resource "azurerm_subnet" "onprem_app" {
  name                            = "snet-onprem"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.onprem.name
  address_prefixes                = [local.onprem_app_cidr]
  default_outbound_access_enabled = true
}

# ── The VPN gateways: vpngw-azure (ASN 65010) and vpngw-onprem (65020) ────

# Standard and zone-redundant: an AZ gateway SKU needs a zone-redundant
# Standard public IP (Basic public IPs are retired).
resource "azurerm_public_ip" "azure_gateway" {
  name                = "pip-vpngw-azure"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_public_ip" "onprem_gateway" {
  name                = "pip-vpngw-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_virtual_network_gateway" "azure" {
  name                = "vpngw-azure"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  type                = "Vpn"
  vpn_type            = "RouteBased"
  sku                 = "VpnGw1AZ"
  generation          = "Generation1"
  active_active       = false
  bgp_enabled         = true
  tags                = var.tags

  bgp_settings {
    asn = 65010
  }

  ip_configuration {
    name                          = "gwipconfig"
    public_ip_address_id          = azurerm_public_ip.azure_gateway.id
    private_ip_address_allocation = "Dynamic"
    subnet_id                     = azurerm_subnet.azure_gateway.id
  }
}

resource "azurerm_virtual_network_gateway" "onprem" {
  name                = "vpngw-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  type                = "Vpn"
  vpn_type            = "RouteBased"
  sku                 = "VpnGw1AZ"
  generation          = "Generation1"
  active_active       = false
  bgp_enabled         = true
  tags                = var.tags

  bgp_settings {
    asn = 65020
  }

  ip_configuration {
    name                          = "gwipconfig"
    public_ip_address_id          = azurerm_public_ip.onprem_gateway.id
    private_ip_address_allocation = "Dynamic"
    subnet_id                     = azurerm_subnet.onprem_gateway.id
  }
}

# ── Local network gateways: each describes the other side ────────────────

# What vpngw-azure knows about "on-prem": where its VPN device is, what
# addresses are behind it, and who to talk BGP to. A gateway's BGP peering
# address is Azure's to choose (from its GatewaySubnet), known only once the
# gateway exists; try() lets labs-tf's mocked plan, which has none, through.
resource "azurerm_local_network_gateway" "onprem" {
  name                = "lgw-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  gateway_address     = azurerm_public_ip.onprem_gateway.ip_address
  address_space       = [local.onprem_cidr]
  tags                = var.tags

  bgp_settings {
    asn                 = 65020
    bgp_peering_address = try(azurerm_virtual_network_gateway.onprem.bgp_settings[0].peering_addresses[0].default_addresses[0], "")
  }
}

# And what vpngw-onprem knows about Azure.
resource "azurerm_local_network_gateway" "azure" {
  name                = "lgw-azure"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  gateway_address     = azurerm_public_ip.azure_gateway.ip_address
  address_space       = [local.azure_cidr]
  tags                = var.tags

  bgp_settings {
    asn                 = 65010
    bgp_peering_address = try(azurerm_virtual_network_gateway.azure.bgp_settings[0].peering_addresses[0].default_addresses[0], "")
  }
}

# ── The tunnel: one IPsec connection from each end ───────────────────────

# The pre-shared key both ends must agree on. Letters and digits only. The two
# connections below spell out the same IPsec/IKE policy: change one end only
# and the tunnel never comes up.
resource "random_password" "psk" {
  length  = 32
  special = false
}

resource "azurerm_virtual_network_gateway_connection" "azure_to_onprem" {
  name                       = "cn-azure-to-onprem"
  resource_group_name        = azurerm_resource_group.lab.name
  location                   = azurerm_resource_group.lab.location
  type                       = "IPsec"
  virtual_network_gateway_id = azurerm_virtual_network_gateway.azure.id
  local_network_gateway_id   = azurerm_local_network_gateway.onprem.id
  shared_key                 = random_password.psk.result
  bgp_enabled                = true
  tags                       = var.tags

  ipsec_policy {
    dh_group         = "DHGroup14"
    ike_encryption   = "AES256"
    ike_integrity    = "SHA256"
    ipsec_encryption = "GCMAES256"
    ipsec_integrity  = "GCMAES256"
    pfs_group        = "PFS14"
    sa_lifetime      = 27000
  }
}

resource "azurerm_virtual_network_gateway_connection" "onprem_to_azure" {
  name                       = "cn-onprem-to-azure"
  resource_group_name        = azurerm_resource_group.lab.name
  location                   = azurerm_resource_group.lab.location
  type                       = "IPsec"
  virtual_network_gateway_id = azurerm_virtual_network_gateway.onprem.id
  local_network_gateway_id   = azurerm_local_network_gateway.azure.id
  shared_key                 = random_password.psk.result
  bgp_enabled                = true
  tags                       = var.tags

  ipsec_policy {
    dh_group         = "DHGroup14"
    ike_encryption   = "AES256"
    ike_integrity    = "SHA256"
    ipsec_encryption = "GCMAES256"
    ipsec_integrity  = "GCMAES256"
    pfs_group        = "PFS14"
    sa_lifetime      = 27000
  }
}

# ── A VM on each side: vm-azure and vm-onprem ────────────────────────────

resource "azurerm_network_interface" "azure" {
  name                = "nic-vm-azure"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.azure_app.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "azure" {
  name                            = "vm-azure"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.azure.id]
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

resource "azurerm_network_interface" "onprem" {
  name                = "nic-vm-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.onprem_app.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "onprem" {
  name                            = "vm-onprem"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.onprem.id]
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
