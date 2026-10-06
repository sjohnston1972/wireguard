# main.tf
#
# Plain English: every kind of Azure load balancer in one lab.
#
#   lb-global   a global-tier (cross-region) load balancer, homed in the
#               session's region (uksouth), on a Global public IP. Its one
#               pool holds the two regional load balancers' frontends, and its
#               one rule takes TCP 80. It has no probe: it reads the regional
#               load balancers' health, and fails over when a region has none.
#   lb-uks      a regional public Standard load balancer in uksouth over
#               vm-web1: a rule for TCP 80 (outbound SNAT off), an HTTP probe,
#               an inbound NAT rule (version 2: frontend ports 8081-8090 to
#               port 80 on the pool) and an explicit outbound rule. It has two
#               frontends, each on its own public IP: fe-uks (the rule, the
#               outbound rule, and lb-global's member) and fe-uks-chained (the
#               NAT rule), which is chained to lb-gw, so every packet to and
#               from it passes through the appliance VM. Learn: "Gateway Load
#               Balancer doesn't work with the Global Load Balancer tier", so
#               the frontend lb-global points at is never the chained one.
#   lb-gw       a Gateway load balancer in snet-nva: HA ports, a TCP 22 probe
#               and a pool with two VXLAN tunnel interfaces (internal 10800 /
#               VNI 800, external 10801 / VNI 801) holding vm-nva, a Linux
#               bridge between the two tunnels (cloud-init, nothing installed).
#   lb-ukw      the same regional load balancer in ukwest over vm-web2, with
#               no chain, in rg-lab-<id>-secondary.
#
# No VM has a public IP. The web subnets' NSGs let the internet in on port
# 80 only (an NSG sees the NAT rule's 8081-8090 after translation, as 80);
# SSH is never open to the internet. The web and appliance subnets have
# default outbound access off: the outbound rules are the only way out
# (ruling 37).

locals {
  # The first /20 of the slot is vnet-uks (uksouth), the second vnet-ukw (ukwest).
  uks_cidr     = cidrsubnet(var.address_space, 2, 0)
  ukw_cidr     = cidrsubnet(var.address_space, 2, 1)
  web_cidr     = cidrsubnet(local.uks_cidr, 4, 0)
  nva_cidr     = cidrsubnet(local.uks_cidr, 4, 1)
  ukw_web_cidr = cidrsubnet(local.ukw_cidr, 4, 0)

  # The Gateway load balancer's fixed frontend: the NVA's VXLAN tunnels end there.
  gw_ip = cidrhost(local.nva_cidr, 10)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_resource_group" "secondary" {
  name     = "${var.resource_group_name}-secondary"
  location = var.secondary_region
  tags     = var.tags
}

# ── Networks: vnet-uks (uksouth) and vnet-ukw (ukwest) ───────────────────

resource "azurerm_virtual_network" "uks" {
  name                = "vnet-uks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.uks_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.uks.name
  address_prefixes     = [local.web_cidr]
  # Out only through lb-uks's outbound rule (ruling 37).
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "nva" {
  name                 = "snet-nva"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.uks.name
  address_prefixes     = [local.nva_cidr]
  # The appliance needs nothing from the internet.
  default_outbound_access_enabled = false
}

resource "azurerm_virtual_network" "ukw" {
  name                = "vnet-ukw"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  address_space       = [local.ukw_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "ukw_web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.secondary.name
  virtual_network_name = azurerm_virtual_network.ukw.name
  address_prefixes     = [local.ukw_web_cidr]
  # Out only through lb-ukw's outbound rule (ruling 37).
  default_outbound_access_enabled = false
}

# ── NSGs: port 80 from the internet to the web subnets, nothing else ─────

resource "azurerm_network_security_group" "web" {
  name                = "nsg-web-uks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# The NAT rule's frontend ports (8081-8090) reach the VM as port 80, and an
# NSG sees the packet after the load balancer has translated it.
resource "azurerm_network_security_rule" "web_http" {
  name                        = "allow-http-from-internet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.web.id
}

resource "azurerm_network_security_group" "nva" {
  name                = "nsg-nva"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# The Gateway load balancer's VXLAN tunnels, from inside the VNet (the
# default rules allow it too; this one says so).
resource "azurerm_network_security_rule" "nva_vxlan" {
  name                        = "allow-vxlan-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.nva.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Udp"
  source_port_range           = "*"
  destination_port_range      = "10800-10801"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "nva" {
  subnet_id                 = azurerm_subnet.nva.id
  network_security_group_id = azurerm_network_security_group.nva.id
}

resource "azurerm_network_security_group" "ukw_web" {
  name                = "nsg-web-ukw"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "ukw_web_http" {
  name                        = "allow-http-from-internet"
  resource_group_name         = azurerm_resource_group.secondary.name
  network_security_group_name = azurerm_network_security_group.ukw_web.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "ukw_web" {
  subnet_id                 = azurerm_subnet.ukw_web.id
  network_security_group_id = azurerm_network_security_group.ukw_web.id
}

# ── VMs: vm-web1 (uksouth), vm-nva (uksouth), vm-web2 (ukwest) ───────────

resource "azurerm_network_interface" "web1" {
  name                = "nic-vm-web1"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "web1" {
  name                            = "vm-web1"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web1.id]
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

  # Managed boot diagnostics: the serial console works with no storage account.
  boot_diagnostics {}

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-web1", region = var.region }))
}

# The appliance: its NIC forwards traffic that is not addressed to it.
resource "azurerm_network_interface" "nva" {
  name                  = "nic-vm-nva"
  resource_group_name   = azurerm_resource_group.lab.name
  location              = azurerm_resource_group.lab.location
  ip_forwarding_enabled = true
  tags                  = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.nva.id
    private_ip_address_allocation = "Dynamic"
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

  boot_diagnostics {}

  custom_data = base64encode(templatefile("${path.module}/nva-cloud-init.yaml.tftpl", { gateway_lb_ip = local.gw_ip }))
}

resource "azurerm_network_interface" "web2" {
  name                = "nic-vm-web2"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.ukw_web.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "web2" {
  name                            = "vm-web2"
  resource_group_name             = azurerm_resource_group.secondary.name
  location                        = azurerm_resource_group.secondary.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web2.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-web2", region = var.secondary_region }))
}

# ── lb-gw: the Gateway load balancer and its appliance ───────────────────

resource "azurerm_lb" "gw" {
  name                = "lb-gw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Gateway"
  tags                = var.tags

  frontend_ip_configuration {
    name                          = "fe-gw"
    subnet_id                     = azurerm_subnet.nva.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.gw_ip
  }
}

# Traffic arrives on the internal tunnel and leaves on the external one (or
# the other way round), each VXLAN on its own UDP port.
resource "azurerm_lb_backend_address_pool" "gw" {
  name            = "pool-nva"
  loadbalancer_id = azurerm_lb.gw.id

  tunnel_interface {
    identifier = 800
    type       = "Internal"
    protocol   = "VXLAN"
    port       = 10800
  }

  tunnel_interface {
    identifier = 801
    type       = "External"
    protocol   = "VXLAN"
    port       = 10801
  }
}

# The appliance is healthy while its sshd answers the load balancer.
resource "azurerm_lb_probe" "gw" {
  name            = "probe-ssh"
  loadbalancer_id = azurerm_lb.gw.id
  protocol        = "Tcp"
  port            = 22
}

# HA ports: every protocol and port goes to the appliance.
resource "azurerm_lb_rule" "gw" {
  name                           = "rule-ha-ports"
  loadbalancer_id                = azurerm_lb.gw.id
  protocol                       = "All"
  frontend_port                  = 0
  backend_port                   = 0
  frontend_ip_configuration_name = "fe-gw"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.gw.id]
  probe_id                       = azurerm_lb_probe.gw.id
}

resource "azurerm_network_interface_backend_address_pool_association" "nva" {
  network_interface_id    = azurerm_network_interface.nva.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.gw.id
}

# ── lb-uks: regional public load balancer in uksouth, chained to lb-gw ───

resource "azurerm_public_ip" "uks" {
  name                = "pip-lb-uks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

# The chained frontend's own address: curl it on 8081 (the NAT rule).
resource "azurerm_public_ip" "uks_chained" {
  name                = "pip-lb-uks-chained"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_lb" "uks" {
  name                = "lb-uks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  tags                = var.tags

  # The first frontend (frontend_ip_configuration[0]): lb-global's member,
  # never chained (Gateway Load Balancer doesn't work with the global tier).
  frontend_ip_configuration {
    name                 = "fe-uks"
    public_ip_address_id = azurerm_public_ip.uks.id
  }

  # The second: the chain. Packets to and from it pass through lb-gw first.
  frontend_ip_configuration {
    name                                               = "fe-uks-chained"
    public_ip_address_id                               = azurerm_public_ip.uks_chained.id
    gateway_load_balancer_frontend_ip_configuration_id = azurerm_lb.gw.frontend_ip_configuration[0].id
  }
}

resource "azurerm_lb_backend_address_pool" "uks" {
  name            = "pool-web"
  loadbalancer_id = azurerm_lb.uks.id
}

resource "azurerm_lb_probe" "uks" {
  name            = "probe-http"
  loadbalancer_id = azurerm_lb.uks.id
  protocol        = "Http"
  port            = 80
  request_path    = "/"
}

# Outbound SNAT is the outbound rule's job, so the rule turns its own off.
resource "azurerm_lb_rule" "uks" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.uks.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-uks"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.uks.id]
  probe_id                       = azurerm_lb_probe.uks.id
  disable_outbound_snat          = true
}

# Inbound NAT rule, version 2: a frontend port range over the pool. Each
# member gets the next port (vm-web1 is 8081), always to port 80, never 22.
# It is on the chained frontend, so this is the path through vm-nva.
resource "azurerm_lb_nat_rule" "uks" {
  name                           = "nat-web-8081-8090"
  resource_group_name            = azurerm_resource_group.lab.name
  loadbalancer_id                = azurerm_lb.uks.id
  protocol                       = "Tcp"
  frontend_port_start            = 8081
  frontend_port_end              = 8090
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-uks-chained"
  backend_address_pool_id        = azurerm_lb_backend_address_pool.uks.id
}

# Explicit outbound: the pool's VMs share the frontend's address, 1,024
# ports each.
resource "azurerm_lb_outbound_rule" "uks" {
  name                     = "outbound-web"
  loadbalancer_id          = azurerm_lb.uks.id
  protocol                 = "All"
  backend_address_pool_id  = azurerm_lb_backend_address_pool.uks.id
  allocated_outbound_ports = 1024
  idle_timeout_in_minutes  = 4
  tcp_reset_enabled        = true

  frontend_ip_configuration {
    name = "fe-uks"
  }
}

resource "azurerm_network_interface_backend_address_pool_association" "web1" {
  network_interface_id    = azurerm_network_interface.web1.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.uks.id
}

# ── lb-ukw: regional public load balancer in ukwest ──────────────────────

resource "azurerm_public_ip" "ukw" {
  name                = "pip-lb-ukw"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_lb" "ukw" {
  name                = "lb-ukw"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  sku                 = "Standard"
  tags                = var.tags

  frontend_ip_configuration {
    name                 = "fe-ukw"
    public_ip_address_id = azurerm_public_ip.ukw.id
  }
}

resource "azurerm_lb_backend_address_pool" "ukw" {
  name            = "pool-web"
  loadbalancer_id = azurerm_lb.ukw.id
}

resource "azurerm_lb_probe" "ukw" {
  name            = "probe-http"
  loadbalancer_id = azurerm_lb.ukw.id
  protocol        = "Http"
  port            = 80
  request_path    = "/"
}

resource "azurerm_lb_rule" "ukw" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.ukw.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-ukw"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.ukw.id]
  probe_id                       = azurerm_lb_probe.ukw.id
  disable_outbound_snat          = true
}

resource "azurerm_lb_outbound_rule" "ukw" {
  name                     = "outbound-web"
  loadbalancer_id          = azurerm_lb.ukw.id
  protocol                 = "All"
  backend_address_pool_id  = azurerm_lb_backend_address_pool.ukw.id
  allocated_outbound_ports = 1024
  idle_timeout_in_minutes  = 4
  tcp_reset_enabled        = true

  frontend_ip_configuration {
    name = "fe-ukw"
  }
}

resource "azurerm_network_interface_backend_address_pool_association" "web2" {
  network_interface_id    = azurerm_network_interface.web2.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.ukw.id
}

# ── lb-global: the cross-region load balancer, homed in uksouth ──────────

resource "azurerm_public_ip" "global" {
  name                = "pip-lb-global"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  sku_tier            = "Global"
  tags                = var.tags
}

resource "azurerm_lb" "global" {
  name                = "lb-global"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  sku_tier            = "Global"
  tags                = var.tags

  frontend_ip_configuration {
    name                 = "fe-global"
    public_ip_address_id = azurerm_public_ip.global.id
  }
}

resource "azurerm_lb_backend_address_pool" "global" {
  name            = "pool-regions"
  loadbalancer_id = azurerm_lb.global.id
}

# The members are the regional load balancers' frontends, not VMs: lb-uks's
# first frontend, fe-uks, the one that is not chained to lb-gw.
resource "azurerm_lb_backend_address_pool_address" "uks" {
  name                                = "lb-uks"
  backend_address_pool_id             = azurerm_lb_backend_address_pool.global.id
  backend_address_ip_configuration_id = azurerm_lb.uks.frontend_ip_configuration[0].id
}

resource "azurerm_lb_backend_address_pool_address" "ukw" {
  name                                = "lb-ukw"
  backend_address_pool_id             = azurerm_lb_backend_address_pool.global.id
  backend_address_ip_configuration_id = azurerm_lb.ukw.frontend_ip_configuration[0].id
}

# The backend port is the regional rules' frontend port. No probe: the global
# tier follows the regional load balancers' own health.
resource "azurerm_lb_rule" "global" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.global.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-global"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.global.id]
}
