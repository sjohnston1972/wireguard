# main.tf
#
# Plain English: watching and securing a VNet.
#
#   vnet-hub      AzureBastionSubnet (a /26), snet-web and snet-app (/24s).
#   bas-hub       Azure Bastion Basic with a Standard public IP: the only way
#                 to SSH to the VMs. AzureBastionSubnet's NSG carries the
#                 rules Learn documents for it (443 in from the internet,
#                 GatewayManager and the load balancer, 8080/5701 within the
#                 VNet; 22/3389 out to the VNet, 443 to AzureCloud, 8080/5701
#                 within the VNet, 80 to the internet). Remove one and Bastion
#                 breaks.
#   vm-web, vm-app  Standard_B1s VMs serving their names on port 80, with the
#                 Network Watcher agent. Their NSGs: SSH only from the Bastion
#                 subnet, web may reach app on 80, app may not reach web, the
#                 rest of the VNet may not reach app at all. IP flow verify
#                 and NSG diagnostics show each decision.
#   lab-<id>-vnet a VNet flow log (version 2, 1 day's retention) on the
#                 region's own Network Watcher, NetworkWatcher_<region>, in
#                 Azure's NetworkWatcherRG: scope exception S2 (ruling 48,
#                 approved by Steven 2026-10-05), the only thing a lab may put
#                 there. It logs vnet-hub into <prefix>flow, the lab's storage
#                 account, with traffic analytics every 10 minutes into
#                 log-flow, the lab's capped workspace. Deleting the VNet
#                 deletes it too; the safety net deletes it by name if not.
#
# The lab never makes a Network Watcher: one per region already exists. No
# VM has a public IP and SSH is never open to the internet.

locals {
  # The first /20 of the slot. AzureBastionSubnet is the first /26 (inside
  # the first /24); snet-web and snet-app are the second and third /24s.
  hub_cidr     = cidrsubnet(var.address_space, 2, 0)
  bastion_cidr = cidrsubnet(local.hub_cidr, 6, 0)
  web_cidr     = cidrsubnet(local.hub_cidr, 4, 1)
  app_cidr     = cidrsubnet(local.hub_cidr, 4, 2)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "bastion" {
  name                            = "AzureBastionSubnet"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.bastion_cidr]
  default_outbound_access_enabled = true
}

# The VMs fetch the Network Watcher agent, so outbound access stays on (ruling 37).
resource "azurerm_subnet" "web" {
  name                            = "snet-web"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.web_cidr]
  default_outbound_access_enabled = true
}

resource "azurerm_subnet" "app" {
  name                            = "snet-app"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.app_cidr]
  default_outbound_access_enabled = true
}

# ── AzureBastionSubnet's NSG: the rules Learn documents ──────────────────

resource "azurerm_network_security_group" "bastion" {
  name                = "nsg-bastion"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# Inbound: your browser reaches Bastion on 443.
resource "azurerm_network_security_rule" "bastion_https_in" {
  name                        = "AllowHttpsInbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
}

# Inbound: Azure's control plane manages Bastion.
resource "azurerm_network_security_rule" "bastion_gateway_manager_in" {
  name                        = "AllowGatewayManagerInbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 130
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = "GatewayManager"
  destination_address_prefix  = "*"
}

# Inbound: Azure's health probes.
resource "azurerm_network_security_rule" "bastion_load_balancer_in" {
  name                        = "AllowAzureLoadBalancerInbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 140
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = "AzureLoadBalancer"
  destination_address_prefix  = "*"
}

# Inbound: Bastion's own instances talk to each other.
resource "azurerm_network_security_rule" "bastion_host_in" {
  name                        = "AllowBastionHostCommunication"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 150
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_ranges     = ["8080", "5701"]
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "VirtualNetwork"
}

# Outbound: SSH and RDP to the VMs.
resource "azurerm_network_security_rule" "bastion_ssh_rdp_out" {
  name                        = "AllowSshRdpOutbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 100
  direction                   = "Outbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_ranges     = ["22", "3389"]
  source_address_prefix       = "*"
  destination_address_prefix  = "VirtualNetwork"
}

# Outbound: Azure's public endpoints (diagnostics, metering).
resource "azurerm_network_security_rule" "bastion_azure_cloud_out" {
  name                        = "AllowAzureCloudOutbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 110
  direction                   = "Outbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = "*"
  destination_address_prefix  = "AzureCloud"
}

resource "azurerm_network_security_rule" "bastion_host_out" {
  name                        = "AllowBastionCommunication"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 120
  direction                   = "Outbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_ranges     = ["8080", "5701"]
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "VirtualNetwork"
}

# Outbound: session information and certificate checks.
resource "azurerm_network_security_rule" "bastion_http_out" {
  name                        = "AllowHttpOutbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.bastion.name
  priority                    = 130
  direction                   = "Outbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = "*"
  destination_address_prefix  = "Internet"
}

resource "azurerm_subnet_network_security_group_association" "bastion" {
  subnet_id                 = azurerm_subnet.bastion.id
  network_security_group_id = azurerm_network_security_group.bastion.id

  # Every rule in place before the NSG reaches the subnet, or Bastion is refused.
  depends_on = [
    azurerm_network_security_rule.bastion_https_in,
    azurerm_network_security_rule.bastion_gateway_manager_in,
    azurerm_network_security_rule.bastion_load_balancer_in,
    azurerm_network_security_rule.bastion_host_in,
    azurerm_network_security_rule.bastion_ssh_rdp_out,
    azurerm_network_security_rule.bastion_azure_cloud_out,
    azurerm_network_security_rule.bastion_host_out,
    azurerm_network_security_rule.bastion_http_out,
  ]
}

# ── snet-web's NSG: SSH from Bastion, nothing from snet-app ──────────────

resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "web_ssh_bastion" {
  name                        = "allow-ssh-from-bastion"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = local.bastion_cidr
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "web_deny_app" {
  name                        = "deny-from-app"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = local.app_cidr
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "web_deny_ssh" {
  name                        = "deny-ssh-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.web.name
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.web.id
}

# ── snet-app's NSG: SSH from Bastion, 80 from snet-web, nothing else ─────

resource "azurerm_network_security_group" "app" {
  name                = "nsg-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "app_ssh_bastion" {
  name                        = "allow-ssh-from-bastion"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.app.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefix       = local.bastion_cidr
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "app_http_web" {
  name                        = "allow-http-from-web"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.app.name
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "80"
  source_address_prefix       = local.web_cidr
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "app_deny_vnet" {
  name                        = "deny-vnet-inbound"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.app.name
  priority                    = 120
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# ── VMs: vm-web and vm-app, with the Network Watcher agent ───────────────

resource "azurerm_network_interface" "web" {
  name                = "nic-vm-web"
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
  name                            = "vm-web"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web.id]
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-web" }))
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-app" }))
}

resource "azurerm_virtual_machine_extension" "nw_web" {
  name                       = "AzureNetworkWatcherExtension"
  virtual_machine_id         = azurerm_linux_virtual_machine.web.id
  publisher                  = "Microsoft.Azure.NetworkWatcher"
  type                       = "NetworkWatcherAgentLinux"
  type_handler_version       = "1.4"
  auto_upgrade_minor_version = true
  tags                       = var.tags
}

resource "azurerm_virtual_machine_extension" "nw_app" {
  name                       = "AzureNetworkWatcherExtension"
  virtual_machine_id         = azurerm_linux_virtual_machine.app.id
  publisher                  = "Microsoft.Azure.NetworkWatcher"
  type                       = "NetworkWatcherAgentLinux"
  type_handler_version       = "1.4"
  auto_upgrade_minor_version = true
  tags                       = var.tags
}

# ── Azure Bastion Basic ──────────────────────────────────────────────────

resource "azurerm_public_ip" "bastion" {
  name                = "pip-bastion"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_bastion_host" "hub" {
  name                = "bas-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Basic"
  tags                = var.tags

  ip_configuration {
    name                 = "ipconfig1"
    subnet_id            = azurerm_subnet.bastion.id
    public_ip_address_id = azurerm_public_ip.bastion.id
  }

  depends_on = [azurerm_subnet_network_security_group_association.bastion]
}

# ── The flow log, its storage account and traffic analytics' workspace ───

# In the session's region: a flow log's account must be in its watcher's region.
resource "azurerm_storage_account" "flow" {
  name                            = "${var.name_prefix}flow"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

# Traffic analytics makes its NWTA* data collection rule and endpoint in
# this workspace's group, the lab's.
resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-flow"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.05
  tags                = var.tags
}

# Scope exception S2 (ruling 48): the only resource a lab puts in
# NetworkWatcherRG, on the region's own watcher, named lab-<id>-*, logging
# this lab's VNet into this lab's account and workspace.
resource "azurerm_network_watcher_flow_log" "vnet" {
  name                 = "lab-${var.lab_id}-vnet"
  resource_group_name  = "NetworkWatcherRG"
  network_watcher_name = "NetworkWatcher_${var.region}"
  location             = var.region
  target_resource_id   = azurerm_virtual_network.hub.id
  storage_account_id   = azurerm_storage_account.flow.id
  enabled              = true
  version              = 2
  tags                 = var.tags

  retention_policy {
    enabled = true
    days    = 1
  }

  traffic_analytics {
    enabled               = true
    interval_in_minutes   = 10
    workspace_id          = azurerm_log_analytics_workspace.lab.workspace_id
    workspace_region      = azurerm_log_analytics_workspace.lab.location
    workspace_resource_id = azurerm_log_analytics_workspace.lab.id
  }
}
