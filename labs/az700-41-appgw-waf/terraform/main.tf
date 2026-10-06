# main.tf
#
# Plain English: a web application firewall in front of two web VMs.
#
#   agw-hub     Application Gateway WAF_v2 in snet-agw, autoscaling from 0 to
#               2 instances. Azure insists it owns a public IP (pip-agw), but
#               nothing listens there: both listeners are on the private
#               frontend (the 10th address of snet-agw). HTTP on 80 redirects
#               to HTTPS on 443; HTTPS uses a certificate from Key Vault, goes
#               to both VMs on port 80 and passes a rewrite set that adds
#               X-Lab: 41 and removes the Server header from every response.
#   waf-hub     a WAF policy in Prevention mode: Microsoft's Default Rule Set
#               2.1 and one custom rule that blocks any query string holding
#               attack=1.
#   <prefix>kv  a Key Vault (access policies, no purge protection) holding a
#               self-signed certificate for app.lab41.internal, made by the
#               pipeline. The gateway reads it as a secret through its
#               user-assigned identity, id-<prefix>-agw, which an access
#               policy lets get secrets and nothing else (ruling 52: no role
#               assignment, so no identity change).
#   lab41.internal  a private DNS zone, app -> the private frontend, linked to
#               vnet-hub; the pipeline links it to the gateway VNet while the
#               lab is peered (dns_link).
#   log-agw     a capped workspace receiving the gateway's access and
#               firewall logs in resource-specific tables (AGWAccessLogs,
#               AGWFirewallLogs).
#
# No VM has a public IP and SSH is never open to the internet. The gateway
# takes 5 to 15 minutes to create and about as long to delete.

data "azurerm_client_config" "current" {}

locals {
  # The first /20 of the slot: snet-agw is its first /24, snet-web the second.
  hub_cidr = cidrsubnet(var.address_space, 2, 0)
  agw_cidr = cidrsubnet(local.hub_cidr, 4, 0)
  web_cidr = cidrsubnet(local.hub_cidr, 4, 1)

  # The gateway's fixed private frontend, so the zone and the Connect lines can name it.
  agw_ip = cidrhost(local.agw_cidr, 10)
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

# An Application Gateway needs a subnet of its own. It reaches Key Vault's
# public endpoint for the certificate, so outbound access stays on (ruling 37).
resource "azurerm_subnet" "agw" {
  name                            = "snet-agw"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.agw_cidr]
  default_outbound_access_enabled = true
}

# The web VMs install nothing and answer only the gateway.
resource "azurerm_subnet" "web" {
  name                            = "snet-web"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.hub.name
  address_prefixes                = [local.web_cidr]
  default_outbound_access_enabled = false
}

resource "azurerm_network_security_group" "agw" {
  name                = "nsg-agw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# Azure manages the gateway through these ports; without them it never starts.
resource "azurerm_network_security_rule" "agw_manager" {
  name                        = "allow-gateway-manager"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.agw.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "65200-65535"
  source_address_prefix       = "GatewayManager"
  destination_address_prefix  = "*"
}

# The listeners, from inside the VNet (and the tunnel, while peered).
resource "azurerm_network_security_rule" "agw_web" {
  name                        = "allow-web-from-vnet"
  resource_group_name         = azurerm_resource_group.lab.name
  network_security_group_name = azurerm_network_security_group.agw.name
  priority                    = 110
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_ranges     = ["80", "443"]
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "agw" {
  subnet_id                 = azurerm_subnet.agw.id
  network_security_group_id = azurerm_network_security_group.agw.id
}

# ── The web VMs: vm-web1 and vm-web2 ─────────────────────────────────────

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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-web1" }))
}

resource "azurerm_network_interface" "web2" {
  name                = "nic-vm-web2"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "web2" {
  name                            = "vm-web2"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { name = "vm-web2" }))
}

# ── Key Vault and the certificate ────────────────────────────────────────

resource "azurerm_key_vault" "lab" {
  name                          = "${var.name_prefix}kv"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = false
  public_network_access_enabled = true
  soft_delete_retention_days    = 7
  purge_protection_enabled      = false
  tags                          = var.tags
}

# The pipeline makes the certificate (and deletes it at tear-down).
resource "azurerm_key_vault_access_policy" "pipeline" {
  key_vault_id            = azurerm_key_vault.lab.id
  tenant_id               = data.azurerm_client_config.current.tenant_id
  object_id               = data.azurerm_client_config.current.object_id
  certificate_permissions = ["Create", "Delete", "Get", "List", "Purge"]
  secret_permissions      = ["Get"]
}

resource "azurerm_user_assigned_identity" "agw" {
  name                = "id-${var.name_prefix}-agw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# The gateway reads the certificate (with its private key) as a secret.
resource "azurerm_key_vault_access_policy" "agw" {
  key_vault_id       = azurerm_key_vault.lab.id
  tenant_id          = data.azurerm_client_config.current.tenant_id
  object_id          = azurerm_user_assigned_identity.agw.principal_id
  secret_permissions = ["Get"]
}

# Self-signed, for app.lab41.internal, valid 12 months, renewed by the vault
# 30 days before it expires.
resource "azurerm_key_vault_certificate" "app" {
  name         = "cert-app"
  key_vault_id = azurerm_key_vault.lab.id
  tags         = var.tags

  certificate_policy {
    issuer_parameters {
      name = "Self"
    }

    key_properties {
      exportable = true
      key_size   = 2048
      key_type   = "RSA"
      reuse_key  = true
    }

    lifetime_action {
      action {
        action_type = "AutoRenew"
      }

      trigger {
        days_before_expiry = 30
      }
    }

    secret_properties {
      content_type = "application/x-pkcs12"
    }

    x509_certificate_properties {
      subject            = "CN=app.lab41.internal"
      validity_in_months = 12
      key_usage          = ["digitalSignature", "keyEncipherment"]
      extended_key_usage = ["1.3.6.1.5.5.7.3.1"]

      subject_alternative_names {
        dns_names = ["app.lab41.internal"]
      }
    }
  }

  depends_on = [azurerm_key_vault_access_policy.pipeline]
}

# ── The WAF policy ───────────────────────────────────────────────────────

resource "azurerm_web_application_firewall_policy" "hub" {
  name                = "waf-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  policy_settings {
    enabled                     = true
    mode                        = "Prevention"
    request_body_check          = true
    max_request_body_size_in_kb = 128
    file_upload_limit_in_mb     = 100
  }

  managed_rules {
    managed_rule_set {
      type    = "Microsoft_DefaultRuleSet"
      version = "2.1"
    }
  }

  # Custom rules run before the managed rule set.
  custom_rules {
    name      = "BlockAttackQuery"
    priority  = 10
    rule_type = "MatchRule"
    action    = "Block"

    match_conditions {
      match_variables {
        variable_name = "QueryString"
      }

      operator     = "Contains"
      match_values = ["attack=1"]
      transforms   = ["Lowercase"]
    }
  }
}

# ── The Application Gateway: agw-hub ─────────────────────────────────────

# The gateway must own a public IP, even though nothing listens on it.
resource "azurerm_public_ip" "agw" {
  name                = "pip-agw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_application_gateway" "hub" {
  name                = "agw-hub"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  firewall_policy_id  = azurerm_web_application_firewall_policy.hub.id
  tags                = var.tags

  sku {
    name = "WAF_v2"
    tier = "WAF_v2"
  }

  # No fixed capacity: from 0 instances (only the fixed cost) to 2.
  autoscale_configuration {
    min_capacity = 0
    max_capacity = 2
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.agw.id]
  }

  gateway_ip_configuration {
    name      = "gateway-ip"
    subnet_id = azurerm_subnet.agw.id
  }

  frontend_port {
    name = "port-80"
    port = 80
  }

  frontend_port {
    name = "port-443"
    port = 443
  }

  frontend_ip_configuration {
    name                 = "fe-public"
    public_ip_address_id = azurerm_public_ip.agw.id
  }

  frontend_ip_configuration {
    name                          = "fe-private"
    subnet_id                     = azurerm_subnet.agw.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.agw_ip
  }

  # Versionless: when the vault renews the certificate, the gateway follows.
  ssl_certificate {
    name                = "cert-app"
    key_vault_secret_id = azurerm_key_vault_certificate.app.versionless_secret_id
  }

  backend_address_pool {
    name         = "pool-web"
    ip_addresses = [azurerm_network_interface.web1.private_ip_address, azurerm_network_interface.web2.private_ip_address]
  }

  probe {
    name                = "probe-http"
    protocol            = "Http"
    host                = "127.0.0.1"
    path                = "/"
    interval            = 30
    timeout             = 30
    unhealthy_threshold = 3
  }

  backend_http_settings {
    name                  = "http-80"
    port                  = 80
    protocol              = "Http"
    cookie_based_affinity = "Disabled"
    request_timeout       = 30
    probe_name            = "probe-http"
  }

  # Both listeners on the private frontend: the public IP answers nothing.
  http_listener {
    name                           = "listener-http"
    frontend_ip_configuration_name = "fe-private"
    frontend_port_name             = "port-80"
    protocol                       = "Http"
  }

  http_listener {
    name                           = "listener-https"
    frontend_ip_configuration_name = "fe-private"
    frontend_port_name             = "port-443"
    protocol                       = "Https"
    ssl_certificate_name           = "cert-app"
  }

  redirect_configuration {
    name                 = "http-to-https"
    redirect_type        = "Permanent"
    target_listener_name = "listener-https"
    include_path         = true
    include_query_string = true
  }

  # Every response gets X-Lab: 41 and loses its Server header (an empty
  # value deletes a header).
  rewrite_rule_set {
    name = "rw-headers"

    rewrite_rule {
      name          = "add-x-lab"
      rule_sequence = 100

      response_header_configuration {
        header_name  = "X-Lab"
        header_value = "41"
      }
    }

    rewrite_rule {
      name          = "remove-server"
      rule_sequence = 110

      response_header_configuration {
        header_name  = "Server"
        header_value = ""
      }
    }
  }

  request_routing_rule {
    name                        = "rule-http-redirect"
    priority                    = 100
    rule_type                   = "Basic"
    http_listener_name          = "listener-http"
    redirect_configuration_name = "http-to-https"
  }

  request_routing_rule {
    name                       = "rule-https"
    priority                   = 110
    rule_type                  = "Basic"
    http_listener_name         = "listener-https"
    backend_address_pool_name  = "pool-web"
    backend_http_settings_name = "http-80"
    rewrite_rule_set_name      = "rw-headers"
  }

  # Azure refuses new gateways on the old default policy (TLS 1.0 and 1.1).
  ssl_policy {
    policy_type = "Predefined"
    policy_name = "AppGwSslPolicy20220101"
  }

  # The NSG must be in place before the gateway starts, and its identity
  # must be allowed to read the certificate.
  depends_on = [azurerm_subnet_network_security_group_association.agw, azurerm_key_vault_access_policy.agw]
}

# ── app.lab41.internal ───────────────────────────────────────────────────

resource "azurerm_private_dns_zone" "lab" {
  name                = "lab41.internal"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_a_record" "app" {
  name                = "app"
  zone_name           = azurerm_private_dns_zone.lab.name
  resource_group_name = azurerm_resource_group.lab.name
  ttl                 = 300
  records             = [local.agw_ip]
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "hub" {
  name                  = "link-vnet-hub"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.lab.name
  virtual_network_id    = azurerm_virtual_network.hub.id
  registration_enabled  = false
  tags                  = var.tags
}

# ── Logs ─────────────────────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-agw"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.05
  tags                = var.tags
}

resource "azurerm_monitor_diagnostic_setting" "agw" {
  name                           = "diag-agw"
  target_resource_id             = azurerm_application_gateway.hub.id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.lab.id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "ApplicationGatewayAccessLog"
  }

  enabled_log {
    category = "ApplicationGatewayFirewallLog"
  }
}
