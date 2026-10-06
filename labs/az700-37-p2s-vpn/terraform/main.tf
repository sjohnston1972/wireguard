# main.tf
#
# Plain English: a point-to-site VPN that you sign in to with Entra ID.
#
#   vnet-hub (the first /20 of the slot) has a GatewaySubnet (/27) with a
#   VpnGw1AZ gateway: route-based, active-standby, Generation1, on a Standard
#   zone-redundant public IP. VpnGw1AZ, never Basic (ruling 44): Basic has no
#   OpenVPN and no Entra ID sign-in.
#
#   Its point-to-site configuration: OpenVPN only, Entra ID authentication
#   only, with the Azure VPN Client's Microsoft-registered app as the audience
#   (c632b3df-fb67-4d84-bdcf-b95ad541b5c8). That app needs no registration and
#   no admin consent in the tenant, so this lab changes no permissions. The
#   tenant and issuer are the pipeline's own tenant (data.azurerm_client_config);
#   the issuer must end with a slash.
#
#   Clients get addresses from the last /24 of the slot's fourth /20: inside
#   the slot, outside every VNet, so nothing overlaps.
#
# vm-app in snet-app serves its name on port 80: the thing to reach once you
# are connected. lab-<id>-vpnuser is an Entra user to sign in as (the
# session's password, no forced change), in case your own account cannot.
# The gateway takes 30 to 40 minutes to create and about 20 to delete.

data "azurerm_client_config" "current" {}

locals {
  hub_cidr     = cidrsubnet(var.address_space, 2, 0)
  gateway_cidr = cidrsubnet(local.hub_cidr, 7, 0)
  app_cidr     = cidrsubnet(local.hub_cidr, 4, 1)
  # The client pool: the last /24 of the fourth /20, which no VNet uses.
  p2s_pool = cidrsubnet(cidrsubnet(var.address_space, 2, 3), 4, 15)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ──────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

# A gateway needs a subnet named exactly GatewaySubnet, /27 or larger. It keeps
# Azure's long-standing default outbound setting: the gateway uses its own
# public IP, so the setting changes nothing for it.
resource "azurerm_subnet" "gateway" {
  name                            = "GatewaySubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.gateway_cidr]
  default_outbound_access_enabled = true
}

# vm-app's subnet keeps default outbound access, so you can apt install a tool.
resource "azurerm_subnet" "app" {
  name                            = "snet-app"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.app_cidr]
  default_outbound_access_enabled = true
}

# ── The VPN gateway: vpngw-hub ───────────────────────────────────────────

resource "azurerm_public_ip" "gateway" {
  name                = "pip-vpngw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_virtual_network_gateway" "hub" {
  name                = "vpngw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  type                = "Vpn"
  vpn_type            = "RouteBased"
  sku                 = "VpnGw1AZ"
  generation          = "Generation1"
  active_active       = false
  bgp_enabled         = false
  tags                = var.tags

  ip_configuration {
    name                          = "gwipconfig"
    public_ip_address_id          = azurerm_public_ip.gateway.id
    private_ip_address_allocation = "Dynamic"
    subnet_id                     = azurerm_subnet.gateway.id
  }

  vpn_client_configuration {
    address_space        = [local.p2s_pool]
    vpn_client_protocols = ["OpenVPN"]
    vpn_auth_types       = ["AAD"]
    aad_tenant           = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/"
    aad_audience         = "c632b3df-fb67-4d84-bdcf-b95ad541b5c8"
    aad_issuer           = "https://sts.windows.net/${data.azurerm_client_config.current.tenant_id}/"
  }
}

# ── The lab user: lab-<id>-vpnuser ───────────────────────────────────────

# Someone to sign in to the VPN as. Security defaults may ask it to register
# for MFA at its first sign-in. Removed at tear-down (its name starts lab-<id>-).
resource "azuread_user" "vpnuser" {
  display_name          = "lab-${var.lab_id}-vpnuser"
  user_principal_name   = "lab-${var.lab_id}-vpnuser@${var.upn_domain}"
  mail_nickname         = "lab-${var.lab_id}-vpnuser"
  password              = var.admin_password
  force_password_change = false
  usage_location        = "GB"
}

# ── vm-app: the thing to reach over the VPN ──────────────────────────────

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
