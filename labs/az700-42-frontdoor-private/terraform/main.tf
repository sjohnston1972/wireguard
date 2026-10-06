# main.tf
#
# Plain English: Front Door Premium in front of a web server that has no
# public address at all.
#
#   vm-web      serves a page on port 80 (and /static/ files) in snet-web,
#               behind lb-int, an internal Standard load balancer.
#   pls-web     a Private Link service on lb-int's frontend, its NAT address
#               in snet-pls (network policies off there, as Private Link
#               needs). It is never auto-approved: Front Door's request waits
#               for you to approve it (ruling 51), and until then Front Door
#               answers 502.
#   afd-premium a Front Door Premium profile with one endpoint
#               (<prefix>-afd), an origin group probing over HTTP every 100
#               seconds, and one origin: lb-int's private address, reached
#               through a private endpoint Front Door makes on pls-web. One
#               route takes /* over HTTP and HTTPS, redirects HTTP to HTTPS,
#               forwards over HTTP, caches and compresses.
#   ruleslab42  a rule set on the route: /old redirects to /, every response
#               gets X-Lab: 42, and /static/* is cached for an hour whatever
#               the origin says.
#   wafpremium  a Premium WAF policy in Prevention mode: Microsoft's Default
#               Rule Set 2.1, the Bot Manager rule set 1.1 and a rate limit
#               (more than 100 requests a minute from one address is
#               blocked), attached to the endpoint by a security policy.
#
# The lab is never peered: Front Door is the only way in. No public IP, and
# SSH is never open to the internet (use the serial console). Front Door
# takes several minutes to serve a new endpoint everywhere.

locals {
  # The first /20 of the slot: snet-web is its first /24, snet-pls the second.
  app_cidr = cidrsubnet(var.address_space, 2, 0)
  web_cidr = cidrsubnet(local.app_cidr, 4, 0)
  pls_cidr = cidrsubnet(local.app_cidr, 4, 1)

  # The internal load balancer's fixed frontend: Front Door's origin.
  lb_ip = cidrhost(local.web_cidr, 10)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "app" {
  name                = "vnet-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.app_cidr]
  tags                = var.tags
}

# The VM installs nothing and answers only the load balancer.
resource "azurerm_subnet" "web" {
  name                            = "snet-web"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.app.name
  address_prefixes                = [local.web_cidr]
  default_outbound_access_enabled = false
}

# The Private Link service's NAT addresses: Front Door's traffic arrives
# from here. Private Link needs network policies off on this subnet.
resource "azurerm_subnet" "pls" {
  name                                          = "snet-pls"
  resource_group_name                           = azurerm_resource_group.lab.name
  virtual_network_name                          = azurerm_virtual_network.app.name
  address_prefixes                              = [local.pls_cidr]
  private_link_service_network_policies_enabled = false
  default_outbound_access_enabled               = false
}

# ── vm-web ────────────────────────────────────────────────────────────────

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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {}))
}

# ── lb-int and pls-web ───────────────────────────────────────────────────

resource "azurerm_lb" "int" {
  name                = "lb-int"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard"
  tags                = var.tags

  frontend_ip_configuration {
    name                          = "fe-int"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.lb_ip
  }
}

resource "azurerm_lb_backend_address_pool" "int" {
  name            = "pool-web"
  loadbalancer_id = azurerm_lb.int.id
}

resource "azurerm_lb_probe" "int" {
  name            = "probe-http"
  loadbalancer_id = azurerm_lb.int.id
  protocol        = "Http"
  port            = 80
  request_path    = "/"
}

resource "azurerm_lb_rule" "int" {
  name                           = "rule-http-80"
  loadbalancer_id                = azurerm_lb.int.id
  protocol                       = "Tcp"
  frontend_port                  = 80
  backend_port                   = 80
  frontend_ip_configuration_name = "fe-int"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.int.id]
  probe_id                       = azurerm_lb_probe.int.id
}

resource "azurerm_network_interface_backend_address_pool_association" "web" {
  network_interface_id    = azurerm_network_interface.web.id
  ip_configuration_name   = "ipconfig1"
  backend_address_pool_id = azurerm_lb_backend_address_pool.int.id
}

# No auto-approval and no visibility list: Front Door asks by resource id,
# and the request waits for a person (ruling 51).
resource "azurerm_private_link_service" "web" {
  name                                        = "pls-web"
  resource_group_name                         = azurerm_resource_group.lab.name
  location                                    = azurerm_resource_group.lab.location
  load_balancer_frontend_ip_configuration_ids = [azurerm_lb.int.frontend_ip_configuration[0].id]
  tags                                        = var.tags

  nat_ip_configuration {
    name      = "nat-pls"
    subnet_id = azurerm_subnet.pls.id
    primary   = true
  }
}

# ── Front Door Premium ───────────────────────────────────────────────────

resource "azurerm_cdn_frontdoor_profile" "lab" {
  name                = "afd-premium"
  resource_group_name = azurerm_resource_group.lab.name
  sku_name            = "Premium_AzureFrontDoor"
  tags                = var.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "lab" {
  name                     = "${var.name_prefix}-afd"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id
  tags                     = var.tags
}

# Probes from Front Door's edge every 100 s; healthy when 3 of the last 4 pass.
resource "azurerm_cdn_frontdoor_origin_group" "lab" {
  name                     = "og-web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id
  session_affinity_enabled = false

  health_probe {
    protocol            = "Http"
    path                = "/"
    request_type        = "HEAD"
    interval_in_seconds = 100
  }

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }
}

# The origin is lb-int's private address, reached through a private
# endpoint Front Door makes on pls-web in the session's region.
resource "azurerm_cdn_frontdoor_origin" "web" {
  name                           = "origin-lb-int"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.lab.id
  enabled                        = true
  host_name                      = local.lb_ip
  origin_host_header             = local.lb_ip
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true

  private_link {
    private_link_target_id = azurerm_private_link_service.web.id
    location               = var.region
    request_message        = "Front Door lab 42 asks to reach pls-web"
  }
}

# ── The rule set ─────────────────────────────────────────────────────────

resource "azurerm_cdn_frontdoor_rule_set" "lab" {
  name                     = "ruleslab42"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id
}

# /old moves permanently to / on the same host.
resource "azurerm_cdn_frontdoor_rule" "redirect_old" {
  name                      = "redirectold"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.lab.id
  order                     = 1
  behavior_on_match         = "Stop"

  conditions {
    url_path_condition {
      operator     = "Equal"
      match_values = ["old"]
      transforms   = ["Lowercase"]
    }
  }

  actions {
    url_redirect_action {
      redirect_type        = "Moved"
      redirect_protocol    = "MatchRequest"
      destination_hostname = ""
      destination_path     = "/"
    }
  }
}

# Every response says which lab it came through.
resource "azurerm_cdn_frontdoor_rule" "header" {
  name                      = "addheader"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.lab.id
  order                     = 2
  behavior_on_match         = "Continue"

  actions {
    response_header_action {
      header_action = "Overwrite"
      header_name   = "X-Lab"
      value         = "42"
    }
  }
}

# /static/* stays in the edge's cache for an hour, whatever the origin says.
resource "azurerm_cdn_frontdoor_rule" "cache_static" {
  name                      = "cachestatic"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.lab.id
  order                     = 3
  behavior_on_match         = "Continue"

  conditions {
    url_path_condition {
      operator     = "BeginsWith"
      match_values = ["static/"]
    }
  }

  actions {
    route_configuration_override_action {
      cache_behavior                = "OverrideAlways"
      cache_duration                = "01:00:00"
      query_string_caching_behavior = "IgnoreQueryString"
      compression_enabled           = true
    }
  }
}

# Everything, HTTP redirected to HTTPS (Front Door's own certificate on
# *.azurefd.net), forwarded to the origin over HTTP, cached and compressed.
resource "azurerm_cdn_frontdoor_route" "lab" {
  name                          = "route-all"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.lab.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.lab.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.web.id]
  cdn_frontdoor_rule_set_ids    = [azurerm_cdn_frontdoor_rule_set.lab.id]
  patterns_to_match             = ["/*"]
  supported_protocols           = ["Http", "Https"]
  forwarding_protocol           = "HttpOnly"
  https_redirect_enabled        = true
  link_to_default_domain        = true

  cache {
    query_string_caching_behavior = "IgnoreQueryString"
    compression_enabled           = true
    content_types_to_compress     = ["text/html", "text/plain", "text/css", "application/javascript"]
  }

  # The rule set must hold its rules before a route uses it.
  depends_on = [azurerm_cdn_frontdoor_rule.redirect_old, azurerm_cdn_frontdoor_rule.header, azurerm_cdn_frontdoor_rule.cache_static]
}

# ── The WAF policy and the security policy that attaches it ──────────────

resource "azurerm_cdn_frontdoor_firewall_policy" "lab" {
  name                = "wafpremium"
  resource_group_name = azurerm_resource_group.lab.name
  sku_name            = "Premium_AzureFrontDoor"
  enabled             = true
  mode                = "Prevention"
  tags                = var.tags

  # More than 100 requests in a minute from one client address is blocked.
  custom_rule {
    name                           = "RateLimitPerClient"
    enabled                        = true
    priority                       = 10
    type                           = "RateLimitRule"
    action                         = "Block"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 100

    # Every request counts: RequestUri may be the whole URL, so BeginsWith "/"
    # might never match. Any would, but Azure refuses match values with Any
    # and azurerm requires one, so Contains "/" (every URL has one).
    match_condition {
      match_variable = "RequestUri"
      operator       = "Contains"
      match_values   = ["/"]
    }
  }

  managed_rule {
    type    = "Microsoft_DefaultRuleSet"
    version = "2.1"
    action  = "Block"
  }

  managed_rule {
    type    = "Microsoft_BotManagerRuleSet"
    version = "1.1"
    action  = "Block"
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "lab" {
  name                     = "sp-afd"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.lab.id

      association {
        patterns_to_match = ["/*"]

        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.lab.id
        }
      }
    }
  }
}
