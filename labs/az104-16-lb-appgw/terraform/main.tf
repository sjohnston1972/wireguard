# main.tf
#
# Plain English: two ways to spread traffic over the same two web VMs.
#
#   Load balancer (layer 4): an internal Standard load balancer, lbi-web,
#   with a fixed private frontend in snet-web, a TCP probe on port 80 and
#   one rule, 80 to 80. Basic load balancers are retired, so Standard it is.
#
#   Application Gateway (layer 7): Basic SKU, the cheapest, in a /24 of its
#   own (snet-appgw). Azure insists it owns a public IP, so pip-appgw exists,
#   but nothing listens on it: the only listener is on the private frontend.
#   The subnet's NSG lets Azure's GatewayManager in on 65200-65535 (the
#   gateway will not start without it) and the VNet in on 80.
#
# vm-web1 and vm-web2 (count = 2) serve their names on port 80 with python3's
# built-in web server and have no public IP. The gateway takes 5 to 15
# minutes to create and about as long to delete.

locals {
  # The first /20 of the slot: snet-web is its first /24, snet-appgw the second.
  vnet_cidr  = cidrsubnet(var.address_space, 2, 0)
  web_cidr   = cidrsubnet(local.vnet_cidr, 4, 0)
  appgw_cidr = cidrsubnet(local.vnet_cidr, 4, 1)

  # Fixed frontends, so the Connect lines and the readme can name them.
  lb_ip    = cidrhost(local.web_cidr, 10)
  appgw_ip = cidrhost(local.appgw_cidr, 10)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

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

# An Application Gateway needs a subnet of its own.
resource "azurerm_subnet" "appgw" {
  name                 = "snet-appgw"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.appgw_cidr]
}

# ── The web VMs: vm-web1 and vm-web2 ─────────────────────────────────────

resource "azurerm_network_interface" "web" {
  count               = 2
  name                = "nic-vm-web${count.index + 1}"
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
  count                           = 2
  name                            = "vm-web${count.index + 1}"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web[count.index].id]
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

# ── Internal Standard load balancer: lbi-web ─────────────────────────────

resource "azurerm_lb" "web" {
  name                = "lbi-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  tags                = var.tags

  frontend_ip_configuration {
    name                          = "fe-web"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.lb_ip
  }
}

resource "azurerm_lb_backend_address_pool" "web" {
  name            = "pool-web"
  loadbalancer_id = azurerm_lb.web.id
}

resource "azurerm_lb_probe" "http" {
  name            = "probe-tcp-80"
  loadbalancer_id = azurerm_lb.web.id
  protocol        = "Tcp"
  port            = 80
}

resource "azurerm_lb_rule" "http" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.web.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-web"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.web.id]
  probe_id                       = azurerm_lb_probe.http.id
}

resource "azurerm_network_interface_backend_address_pool_association" "web" {
  count                   = 2
  network_interface_id    = azurerm_network_interface.web[count.index].id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.web.id
}

# ── The Application Gateway's subnet NSG ─────────────────────────────────

resource "azurerm_network_security_group" "appgw" {
  name                = "nsg-appgw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# Azure manages the gateway through these ports; without them it never starts.
resource "azurerm_network_security_rule" "appgw_manager" {
  name                        = "allow-gateway-manager"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.appgw.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "65200-65535"
  source_address_prefix       = "GatewayManager"
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "appgw_http" {
  name                        = "allow-http-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.appgw.name
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "appgw" {
  subnet_id                 = azurerm_subnet.appgw.id
  network_security_group_id = azurerm_network_security_group.appgw.id
}

# ── Application Gateway Basic: agw-web ───────────────────────────────────

# The gateway must own a public IP, even though nothing listens on it.
resource "azurerm_public_ip" "appgw" {
  name                = "pip-appgw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_application_gateway" "web" {
  name                = "agw-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  sku {
    name     = "Basic"
    tier     = "Basic"
    capacity = 1
  }

  gateway_ip_configuration {
    name      = "gateway-ip"
    subnet_id = azurerm_subnet.appgw.id
  }

  frontend_port {
    name = "port-80"
    port = 80
  }

  frontend_ip_configuration {
    name                 = "fe-public"
    public_ip_address_id = azurerm_public_ip.appgw.id
  }

  frontend_ip_configuration {
    name                          = "fe-private"
    subnet_id                     = azurerm_subnet.appgw.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.appgw_ip
  }

  backend_address_pool {
    name         = "pool-web"
    ip_addresses = azurerm_network_interface.web[*].private_ip_address
  }

  backend_http_settings {
    name                  = "http-80"
    port                  = 80
    protocol              = "Http"
    cookie_based_affinity = "Disabled"
    request_timeout       = 30
  }

  # The only listener, on the private frontend: the public IP answers nothing.
  http_listener {
    name                           = "listener-private-80"
    frontend_ip_configuration_name = "fe-private"
    frontend_port_name             = "port-80"
    protocol                       = "Http"
  }

  request_routing_rule {
    name                       = "rule-web"
    priority                   = 100
    rule_type                  = "Basic"
    http_listener_name         = "listener-private-80"
    backend_address_pool_name  = "pool-web"
    backend_http_settings_name = "http-80"
  }

  # Azure refuses new gateways on the old default policy (TLS 1.0 and 1.1).
  ssl_policy {
    policy_type = "Predefined"
    policy_name = "AppGwSslPolicy20220101"
  }

  # The NSG must be in place before the gateway starts.
  depends_on = [azurerm_subnet_network_security_group_association.appgw]
}
