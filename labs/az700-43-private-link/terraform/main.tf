# main.tf
#
# Plain English: three ways to reach a service privately, side by side.
#
#   Provider (vnet-provider): vm-svc serves a page on port 80 behind lb-svc,
#   an internal Standard load balancer, published as pls-svc, a Private Link
#   service whose NAT address is in snet-pls. It approves requests from this
#   subscription automatically and is visible only to it (the subscription
#   id from the subscription the pipeline signs in to, a GUID).
#
#   Consumer (vnet-consumer, never peered with the provider):
#     pe-svc    a private endpoint in snet-pe to pls-svc: vm-client reaches
#               vm-svc at an address of its own VNet, and vm-svc sees the
#               request come from pls-svc's NAT address.
#     pe-blob   a private endpoint in snet-pe to <prefix>st's blob service,
#               registered in privatelink.blob.core.windows.net (linked to
#               vnet-consumer), so the account's name resolves to it inside
#               the VNet.
#     snet-client  vm-client's subnet: a Microsoft.Storage service endpoint
#               and a service endpoint policy that allows <prefix>st only, so
#               <prefix>other (same region) is refused over the endpoint.
#
# No public IP and no SSH from the internet. Both accounts are reached by
# the pipeline through the management plane only (containers by
# storage_account_id).

data "azurerm_subscription" "current" {}

locals {
  # The first /20 of the slot is vnet-provider, the second vnet-consumer.
  provider_cidr = cidrsubnet(var.address_space, 2, 0)
  consumer_cidr = cidrsubnet(var.address_space, 2, 1)
  svc_cidr      = cidrsubnet(local.provider_cidr, 4, 0)
  pls_cidr      = cidrsubnet(local.provider_cidr, 4, 1)
  pe_cidr       = cidrsubnet(local.consumer_cidr, 4, 0)
  client_cidr   = cidrsubnet(local.consumer_cidr, 4, 1)

  # lb-svc's fixed frontend.
  lb_ip = cidrhost(local.svc_cidr, 10)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Provider: vnet-provider, vm-svc, lb-svc, pls-svc ──────────────────────

resource "azurerm_virtual_network" "provider" {
  name                = "vnet-provider"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.provider_cidr]
  tags                = var.tags
}

# vm-svc installs nothing and answers only the load balancer.
resource "azurerm_subnet" "svc" {
  name                            = "snet-svc"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.provider.name
  address_prefixes                = [local.svc_cidr]
  default_outbound_access_enabled = false
}

# The Private Link service's NAT addresses; Private Link needs network
# policies off here.
resource "azurerm_subnet" "pls" {
  name                                          = "snet-pls"
  resource_group_name                           = azurerm_resource_group.lab.name
  virtual_network_name                          = azurerm_virtual_network.provider.name
  address_prefixes                              = [local.pls_cidr]
  private_link_service_network_policies_enabled = false
  default_outbound_access_enabled               = false
}

resource "azurerm_network_interface" "svc" {
  name                = "nic-vm-svc"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.svc.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "svc" {
  name                            = "vm-svc"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.svc.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {}))
}

resource "azurerm_lb" "svc" {
  name                = "lb-svc"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  tags                = var.tags

  frontend_ip_configuration {
    name                          = "fe-svc"
    subnet_id                     = azurerm_subnet.svc.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.lb_ip
  }
}

resource "azurerm_lb_backend_address_pool" "svc" {
  name            = "pool-svc"
  loadbalancer_id = azurerm_lb.svc.id
}

resource "azurerm_lb_probe" "svc" {
  name            = "probe-http"
  loadbalancer_id = azurerm_lb.svc.id
  protocol        = "Http"
  port            = 80
  request_path    = "/"
}

resource "azurerm_lb_rule" "svc" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.svc.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-svc"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.svc.id]
  probe_id                       = azurerm_lb_probe.svc.id
}

resource "azurerm_network_interface_backend_address_pool_association" "svc" {
  network_interface_id    = azurerm_network_interface.svc.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.svc.id
}

# Visible to, and approving automatically, only the subscription the lab
# runs in (ruling 51: a GUID, never a path).
resource "azurerm_private_link_service" "svc" {
  name                                        = "pls-svc"
  resource_group_name                         = azurerm_resource_group.lab.name
  location                                    = azurerm_resource_group.lab.location
  load_balancer_frontend_ip_configuration_ids = [azurerm_lb.svc.frontend_ip_configuration[0].id]
  auto_approval_subscription_ids              = [data.azurerm_subscription.current.subscription_id]
  visibility_subscription_ids                 = [data.azurerm_subscription.current.subscription_id]
  tags                                        = var.tags

  nat_ip_configuration {
    name      = "nat-pls"
    subnet_id = azurerm_subnet.pls.id
    primary   = true
  }
}

# ── Storage: <prefix>st (allowed) and <prefix>other (refused) ────────────

resource "azurerm_storage_account" "st" {
  name                            = "${var.name_prefix}st"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = true
  tags                            = var.tags
}

resource "azurerm_storage_account" "other" {
  name                            = "${var.name_prefix}other"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "st" {
  name                  = "data"
  storage_account_id    = azurerm_storage_account.st.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "other" {
  name                  = "data"
  storage_account_id    = azurerm_storage_account.other.id
  container_access_type = "private"
}

# ── Consumer: vnet-consumer, the endpoints, the policy and vm-client ─────

resource "azurerm_virtual_network" "consumer" {
  name                = "vnet-consumer"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.consumer_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "pe" {
  name                            = "snet-pe"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.consumer.name
  address_prefixes                = [local.pe_cidr]
  default_outbound_access_enabled = false
}

# Only <prefix>st, of all the storage accounts in this region, through the
# subnet's storage service endpoint.
resource "azurerm_subnet_service_endpoint_storage_policy" "client" {
  name                = "sep-storage"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  definition {
    name              = "allow-lab-st"
    description       = "The client subnet may reach this lab's first storage account and no other."
    service           = "Microsoft.Storage"
    service_resources = [azurerm_storage_account.st.id]
  }
}

# vm-client reaches storage over the service endpoint, so outbound stays on
# (ruling 37); the policy decides which accounts it may reach.
resource "azurerm_subnet" "client" {
  name                            = "snet-client"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.consumer.name
  address_prefixes                = [local.client_cidr]
  service_endpoints               = ["Microsoft.Storage"]
  service_endpoint_policy_ids     = [azurerm_subnet_service_endpoint_storage_policy.client.id]
  default_outbound_access_enabled = true
}

# The consumer's way to the provider: an address in snet-pe, approved
# automatically because pls-svc trusts this subscription.
resource "azurerm_private_endpoint" "svc" {
  name                          = "pe-svc"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.pe.id
  custom_network_interface_name = "nic-pe-svc"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-svc"
    private_connection_resource_id = azurerm_private_link_service.svc.id
    is_manual_connection           = false
  }
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "consumer" {
  name                  = "link-vnet-consumer"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.consumer.id
  registration_enabled  = false
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "blob" {
  name                          = "pe-blob"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.pe.id
  custom_network_interface_name = "nic-pe-blob"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-blob"
    private_connection_resource_id = azurerm_storage_account.st.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  # The endpoint's address is written into the zone as <prefix>st.
  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

resource "azurerm_network_interface" "client" {
  name                = "nic-vm-client"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.client.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "client" {
  name                            = "vm-client"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.client.id]
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
