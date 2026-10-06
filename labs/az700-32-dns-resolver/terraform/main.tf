# main.tf
#
# Plain English: hybrid DNS in both directions. vnet-hub is "Azure";
# vnet-onprem stands in for an on-premises site (a peering takes the place
# of a VPN or ExpressRoute). The on-prem site has its own DNS server,
# vm-dns, running dnsmasq.
#
#   Azure -> on-prem   vm-app asks Azure DNS for fileserver.onprem.lab32.internal.
#                      The forwarding ruleset linked to vnet-hub sends that
#                      domain out of the resolver's OUTBOUND endpoint to vm-dns.
#   on-prem -> Azure   vnet-onprem's DNS server is vm-dns. dnsmasq forwards
#                      azure.lab32.internal to the resolver's INBOUND endpoint,
#                      which answers from the private zone linked to vnet-hub
#                      (where vm-app registers itself).
#
# vm-dns has a fixed address (the forwarding rule and vnet-onprem's DNS
# setting name it), and its own NIC uses Azure DNS, so its apt install
# works before dnsmasq is running. The inbound endpoint's address is
# dynamic and templated into vm-dns's cloud-init, so vm-dns is made after it.

locals {
  # Two /20s of the slot: "Azure" and "on-prem".
  hub_cidr    = cidrsubnet(var.address_space, 2, 0)
  onprem_cidr = cidrsubnet(var.address_space, 2, 1)

  # The hub: an app /24, then two /28s delegated to the resolver.
  app_subnet = cidrsubnet(local.hub_cidr, 4, 0)
  in_subnet  = cidrsubnet(local.hub_cidr, 8, 16)
  out_subnet = cidrsubnet(local.hub_cidr, 8, 17)

  # On-prem: one /24, and the DNS server's fixed address in it.
  onprem_subnet = cidrsubnet(local.onprem_cidr, 4, 0)
  dns_ip        = cidrhost(local.onprem_subnet, 4)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── "Azure": vnet-hub ─────────────────────────────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.app_subnet]

  # Ruling 37: said explicitly. vm-app installs nothing but may use the internet.
  default_outbound_access_enabled = true
}

# The resolver's endpoints each need a subnet of their own (a /28 or
# larger), delegated to Microsoft.Network/dnsResolvers and holding nothing else.
resource "azurerm_subnet" "in" {
  name                 = "snet-in"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.in_subnet]

  # Azure's long-standing default, said explicitly (ruling 37).
  default_outbound_access_enabled = true

  delegation {
    name = "dnsresolvers"
    service_delegation {
      name    = "Microsoft.Network/dnsResolvers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "out" {
  name                 = "snet-out"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.out_subnet]

  default_outbound_access_enabled = true

  delegation {
    name = "dnsresolvers"
    service_delegation {
      name    = "Microsoft.Network/dnsResolvers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# ── "On-prem": vnet-onprem, whose DNS server is vm-dns ───────────────────

resource "azurerm_virtual_network" "onprem" {
  name                = "vnet-onprem"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.onprem_cidr]
  dns_servers         = [local.dns_ip]
  tags                = var.tags
}

resource "azurerm_subnet" "onprem" {
  name                 = "snet-onprem"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.onprem.name
  address_prefixes     = [local.onprem_subnet]

  # vm-dns installs dnsmasq from Ubuntu's archive.
  default_outbound_access_enabled = true
}

# The "site-to-site link": a peering both ways.
resource "azurerm_virtual_network_peering" "hub_to_onprem" {
  name                         = "peer-hub-to-onprem"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = azurerm_virtual_network.onprem.id
  allow_virtual_network_access = true
}

resource "azurerm_virtual_network_peering" "onprem_to_hub" {
  name                         = "peer-onprem-to-hub"
  resource_group_name          = azurerm_resource_group.lab.name
  virtual_network_name         = azurerm_virtual_network.onprem.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
}

# ── DNS Private Resolver in the hub ──────────────────────────────────────

resource "azurerm_private_dns_resolver" "hub" {
  name                = "dnspr-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  virtual_network_id  = azurerm_virtual_network.hub.id
  tags                = var.tags
}

# Inbound: an address in the hub that on-prem DNS servers forward to.
resource "azurerm_private_dns_resolver_inbound_endpoint" "in" {
  name                    = "in-hub"
  private_dns_resolver_id = azurerm_private_dns_resolver.hub.id
  location                = azurerm_resource_group.lab.location
  tags                    = var.tags

  ip_configurations {
    subnet_id                    = azurerm_subnet.in.id
    private_ip_allocation_method = "Dynamic"
  }
}

# Outbound: where the forwarding ruleset's queries leave the hub from.
resource "azurerm_private_dns_resolver_outbound_endpoint" "out" {
  name                    = "out-hub"
  private_dns_resolver_id = azurerm_private_dns_resolver.hub.id
  location                = azurerm_resource_group.lab.location
  subnet_id               = azurerm_subnet.out.id
  tags                    = var.tags
}

resource "azurerm_private_dns_resolver_dns_forwarding_ruleset" "onprem" {
  name                                       = "frs-onprem"
  resource_group_name                        = azurerm_resource_group.lab.name
  location                                   = azurerm_resource_group.lab.location
  private_dns_resolver_outbound_endpoint_ids = [azurerm_private_dns_resolver_outbound_endpoint.out.id]
  tags                                       = var.tags
}

resource "azurerm_private_dns_resolver_forwarding_rule" "onprem" {
  name                      = "onprem-lab32"
  dns_forwarding_ruleset_id = azurerm_private_dns_resolver_dns_forwarding_ruleset.onprem.id
  domain_name               = "onprem.lab32.internal."
  enabled                   = true

  target_dns_servers {
    ip_address = local.dns_ip
    port       = 53
  }
}

# A VNet uses a ruleset only when linked to it.
resource "azurerm_private_dns_resolver_virtual_network_link" "hub" {
  name                      = "link-hub"
  dns_forwarding_ruleset_id = azurerm_private_dns_resolver_dns_forwarding_ruleset.onprem.id
  virtual_network_id        = azurerm_virtual_network.hub.id
}

# ── The Azure side's private zone (VMs in the hub register themselves) ──
# A .internal name: while the lab is peered, the Worker links this zone to
# the gateway's VNet too (dns_link), and the gateway's dnsmasq already
# forwards internal to Azure DNS.

resource "azurerm_private_dns_zone" "azure" {
  name                = "azure.lab32.internal"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "hub" {
  name                  = "link-hub"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.azure.name
  virtual_network_id    = azurerm_virtual_network.hub.id
  registration_enabled  = true
  tags                  = var.tags
}

# ── vm-app in the hub ────────────────────────────────────────────────────

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
}

# ── vm-dns, the "on-prem" DNS server (dnsmasq) ───────────────────────────

resource "azurerm_network_interface" "dns" {
  name                = "nic-vm-dns"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  # vnet-onprem's DNS server is this VM; the VM itself asks Azure DNS.
  dns_servers = ["168.63.129.16"]

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.onprem.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.dns_ip
  }
}

resource "azurerm_linux_virtual_machine" "dns" {
  name                            = "vm-dns"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.dns.id]
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

  # dnsmasq: authoritative for onprem.lab32.internal, forwarding
  # azure.lab32.internal to the inbound endpoint (dnsmasq-init.yaml.tftpl).
  custom_data = base64encode(templatefile("${path.module}/dnsmasq-init.yaml.tftpl", {
    dns_ip     = local.dns_ip
    inbound_ip = azurerm_private_dns_resolver_inbound_endpoint.in.ip_configurations[0].private_ip_address
  }))
}
