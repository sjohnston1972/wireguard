# main.tf
#
# Plain English: two ways out to the internet that you choose, side by side,
# in one VNet from the first /20 of the slot. Both subnets have default
# outbound access OFF, so a VM there has no way out unless something here
# gives it one:
#
#   snet-nat  vm-nat leaves through the NAT gateway ng-hub, whose addresses
#             are the public IP prefix pfx-nat (a /31: two addresses)
#   snet-lb   vm-lb is in the backend pool of lb-out, a Standard public load
#             balancer whose only frontend is the prefix pfx-lb (another /31)
#             and whose only rule is an OUTBOUND rule: no load-balancing rule,
#             no inbound NAT, nothing comes in
#
# No public IP resource at all: every public address comes from a prefix,
# and no VM has one (spec §3.9). One NSG on both subnets adds no rules to
# Azure's defaults, so nothing from the internet is allowed in. Nothing to
# install, so the VMs need no cloud-init.

locals {
  # One /20 of the slot: the hub.
  hub_cidr = cidrsubnet(var.address_space, 2, 0)

  # Two /24s in it.
  nat_subnet = cidrsubnet(local.hub_cidr, 4, 0)
  lb_subnet  = cidrsubnet(local.hub_cidr, 4, 1)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The VNet and its two subnets (default outbound access off) ───────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "nat" {
  name                 = "snet-nat"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.nat_subnet]

  # The lab teaches explicit outbound (ruling 37): the NAT gateway is the only way out.
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "lb" {
  name                 = "snet-lb"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.lb_subnet]

  # The load balancer's outbound rule is the only way out.
  default_outbound_access_enabled = false
}

# Azure's default rules only: VirtualNetwork and the load balancer's probes
# in, nothing from the internet. Outbound is not filtered.
resource "azurerm_network_security_group" "hub" {
  name                = "nsg-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_subnet_network_security_group_association" "nat" {
  subnet_id                 = azurerm_subnet.nat.id
  network_security_group_id = azurerm_network_security_group.hub.id
}

resource "azurerm_subnet_network_security_group_association" "lb" {
  subnet_id                 = azurerm_subnet.lb.id
  network_security_group_id = azurerm_network_security_group.hub.id
}

# ── Public IP prefixes: two /31s, zone-redundant ─────────────────────────

resource "azurerm_public_ip_prefix" "nat" {
  name                = "pfx-nat"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  prefix_length       = 31
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_public_ip_prefix" "lb" {
  name                = "pfx-lb"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  prefix_length       = 31
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

# ── NAT gateway on snet-nat, its addresses from pfx-nat ──────────────────

resource "azurerm_nat_gateway" "hub" {
  name                    = "ng-hub"
  resource_group_name     = azurerm_resource_group.lab.name
  location                = azurerm_resource_group.lab.location
  sku_name                = "Standard"
  idle_timeout_in_minutes = 4
  tags                    = var.tags
}

resource "azurerm_nat_gateway_public_ip_prefix_association" "nat" {
  nat_gateway_id      = azurerm_nat_gateway.hub.id
  public_ip_prefix_id = azurerm_public_ip_prefix.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "nat" {
  subnet_id      = azurerm_subnet.nat.id
  nat_gateway_id = azurerm_nat_gateway.hub.id
}

# ── An outbound-only public load balancer, its frontend from pfx-lb ──────

resource "azurerm_lb" "out" {
  name                = "lb-out"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  tags                = var.tags

  # A frontend from a prefix may serve outbound rules only: exactly this lab.
  frontend_ip_configuration {
    name                = "fe-out"
    public_ip_prefix_id = azurerm_public_ip_prefix.lb.id
  }
}

resource "azurerm_lb_backend_address_pool" "out" {
  name            = "be-out"
  loadbalancer_id = azurerm_lb.out.id
}

# All protocols out through both of pfx-lb's addresses. Each address has
# 64,000 SNAT ports; giving each VM 32,000 lets the pool grow to four VMs.
resource "azurerm_lb_outbound_rule" "out" {
  name                     = "ob-all"
  loadbalancer_id          = azurerm_lb.out.id
  protocol                 = "All"
  backend_address_pool_id  = azurerm_lb_backend_address_pool.out.id
  allocated_outbound_ports = 32000
  idle_timeout_in_minutes  = 4
  tcp_reset_enabled        = true

  frontend_ip_configuration {
    name = "fe-out"
  }
}

# ── The two VMs: vm-nat behind the NAT gateway, vm-lb in lb-out's pool ───

resource "azurerm_network_interface" "nat" {
  name                = "nic-vm-nat"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.nat.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "nat" {
  name                            = "vm-nat"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.nat.id]
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

resource "azurerm_network_interface" "lb" {
  name                = "nic-vm-lb"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.lb.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_network_interface_backend_address_pool_association" "lb" {
  network_interface_id    = azurerm_network_interface.lb.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.out.id
}

resource "azurerm_linux_virtual_machine" "lb" {
  name                            = "vm-lb"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.lb.id]
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
}
