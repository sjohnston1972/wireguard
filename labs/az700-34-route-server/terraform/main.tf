# main.tf
#
# Plain English: a hub with Azure Route Server, a small Linux router (FRR)
# that talks BGP to it, and a spoke that learns the router's routes through
# the hub.
#
#   vnet-hub (/20 #0)    RouteServerSubnet (/26): rs-hub, Standard, with a
#                        Standard zone-redundant public IP (Route Server
#                        needs one; nothing reaches the VMs through it)
#                        snet-nva (/24): vm-nva, IP forwarding on, FRR
#                        (ASN 65010) peering with both Route Server
#                        instances (ASN 65515) over eBGP multihop
#   vnet-spoke (/20 #1)  snet-app: vm-app, serving its name on port 80
#   advertised (/20 #3)  the first /24, held by a dummy interface on vm-nva
#                        and announced over BGP. It is in no VNet: Route
#                        Server programs it into both VNets with vm-nva as
#                        the next hop
#
# The spoke's peering USES the hub's remote gateway (Route Server counts as
# one), which is what carries the learned routes to the spoke; it is made
# only once the Route Server exists. vm-nva's cloud-init is built from the
# Route Server's own addresses, so the VM is made after it too. Destroy goes
# the other way: the BGP connection and that peering go before the Route
# Server.

locals {
  # Two /20s of the slot for VNets, and the first /24 of the last /20 for
  # the prefix vm-nva advertises.
  hub_cidr          = cidrsubnet(var.address_space, 2, 0)
  spoke_cidr        = cidrsubnet(var.address_space, 2, 1)
  advertised_prefix = cidrsubnet(cidrsubnet(var.address_space, 2, 3), 4, 0)
  advertised_ip     = cidrhost(local.advertised_prefix, 1)

  # The hub: RouteServerSubnet (a /26, its minimum is /27) and the NVA's /24.
  rs_subnet  = cidrsubnet(local.hub_cidr, 6, 0)
  nva_subnet = cidrsubnet(local.hub_cidr, 4, 1)
  nva_ip     = cidrhost(local.nva_subnet, 4)

  app_subnet = cidrsubnet(local.spoke_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The hub ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

# Route Server's subnet must have exactly this name, and no NSG or route table.
resource "azurerm_subnet" "rs" {
  name                 = "RouteServerSubnet"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.rs_subnet]

  # Azure's long-standing default, said explicitly (ruling 37).
  default_outbound_access_enabled = true
}

resource "azurerm_subnet" "nva" {
  name                 = "snet-nva"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.nva_subnet]

  # vm-nva installs FRR from Ubuntu's archive.
  default_outbound_access_enabled = true
}

# ── Route Server ─────────────────────────────────────────────────────────

resource "azurerm_public_ip" "rs" {
  name                = "pip-rs"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  allocation_method   = "Static"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_route_server" "rs" {
  name                             = "rs-hub"
  resource_group_name              = azurerm_resource_group.lab.name
  location                         = azurerm_resource_group.lab.location
  sku                              = "Standard"
  public_ip_address_id             = azurerm_public_ip.rs.id
  subnet_id                        = azurerm_subnet.rs.id
  branch_to_branch_traffic_enabled = false
  tags                             = var.tags
}

# One peer; both Route Server instances accept it (the NVA dials both).
resource "azurerm_route_server_bgp_connection" "nva" {
  name            = "bgp-nva"
  route_server_id = azurerm_route_server.rs.id
  peer_asn        = 65010
  peer_ip         = local.nva_ip
}

# ── vm-nva: the BGP router ───────────────────────────────────────────────

resource "azurerm_network_interface" "nva" {
  name                = "nic-vm-nva"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  # Traffic for the advertised prefix arrives addressed to other machines.
  ip_forwarding_enabled = true

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

  # FRR, the dummy interface and kernel forwarding (frr-init.yaml.tftpl).
  custom_data = base64encode(templatefile("${path.module}/frr-init.yaml.tftpl", {
    asn               = 65010
    router_id         = local.nva_ip
    rs_ips            = azurerm_route_server.rs.virtual_router_ips
    advertised_prefix = local.advertised_prefix
    advertised_ip     = local.advertised_ip
  }))
}

# ── The spoke, using the hub's Route Server as its remote gateway ────────

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

  default_outbound_access_enabled = true
}

resource "azurerm_virtual_network_peering" "hub_to_spoke" {
  name                         = "peer-hub-to-spoke"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.spoke.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
  allow_gateway_transit        = true
}

resource "azurerm_virtual_network_peering" "spoke_to_hub" {
  name                         = "peer-spoke-to-hub"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.spoke.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
  use_remote_gateways          = true

  # Azure refuses use_remote_gateways until the hub has a gateway.
  depends_on = [azurerm_route_server.rs, azurerm_virtual_network_peering.hub_to_spoke]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))
}
