resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [cidrsubnet(var.address_space, 2, 0)]
  tags                = var.tags
}

resource "azurerm_subnet" "gateway" {
  name                            = "GatewaySubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [cidrsubnet(cidrsubnet(var.address_space, 2, 0), 7, 0)]
  default_outbound_access_enabled = false
}

resource "azurerm_virtual_network" "onprem" {
  name                = "vnet-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [cidrsubnet(var.address_space, 2, 1)]
  tags                = var.tags
}

resource "azurerm_public_ip" "gw" {
  name                = "pip-gw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_virtual_network_gateway" "gw" {
  name                = "vgw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  type                = "Vpn"
  vpn_type            = "RouteBased"
  sku                 = "VpnGw1AZ"
  generation          = "Generation1"
  tags                = var.tags

  ip_configuration {
    name                 = "gw"
    public_ip_address_id = azurerm_public_ip.gw.id
    subnet_id            = azurerm_subnet.gateway.id
  }

  vpn_client_configuration {
    address_space        = [cidrsubnet(cidrsubnet(var.address_space, 2, 3), 4, 15)]
    vpn_client_protocols = ["OpenVPN"]
  }
}
