# main.tf
#
# Plain English: one small web app in two regions, with two global front
# ends that fail over between them (labs spec §17, ruling 23).
#
# The app: an Azure Container Instances group in each region, ci-uks in
# rg-lab-<id> (the session's region, uksouth) and ci-ukw in
# rg-lab-<id>-secondary (the secondary region, ukwest). Each runs one
# container from Microsoft's registry (Azure Linux with Python, 0.5 vCPU,
# 0.5 GB) that writes "Hello from <region>" into a page and serves it with
# python3 -m http.server on port 80, on a public IP with a DNS name
# (<prefix>-uks.uksouth.azurecontainer.io). No App Service: the
# subscription's App Service quota is 0.
#
# The front ends, both global and kept in rg-lab-<id>:
#   Traffic Manager (DNS): <prefix>-tm.trafficmanager.net answers with
#   ci-uks's name while its health check passes, else ci-ukw's (Priority
#   routing, two external endpoints, HTTP checks on / every 30 s).
#   Front Door Standard (an anycast reverse proxy): one endpoint, one origin
#   group holding both containers (ci-uks first), one route for /* taking
#   HTTP and HTTPS and forwarding HTTP, no caching and no WAF policy.

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

# ── The app: one container group per region ──────────────────────────────

resource "azurerm_container_group" "uks" {
  name                = "ci-uks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  os_type             = "Linux"
  ip_address_type     = "Public"
  dns_name_label      = "${var.name_prefix}-uks"
  restart_policy      = "Always"
  tags                = var.tags

  container {
    name     = "web"
    image    = "mcr.microsoft.com/azurelinux/base/python:3.12"
    cpu      = 0.5
    memory   = 0.5
    commands = ["/bin/sh", "-c", "mkdir -p /srv && echo \"Hello from ${var.region} (ci-uks)\" > /srv/index.html && exec python3 -m http.server 80 --directory /srv"]

    ports {
      port     = 80
      protocol = "TCP"
    }
  }
}

resource "azurerm_container_group" "ukw" {
  name                = "ci-ukw"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  os_type             = "Linux"
  ip_address_type     = "Public"
  dns_name_label      = "${var.name_prefix}-ukw"
  restart_policy      = "Always"
  tags                = var.tags

  container {
    name     = "web"
    image    = "mcr.microsoft.com/azurelinux/base/python:3.12"
    cpu      = 0.5
    memory   = 0.5
    commands = ["/bin/sh", "-c", "mkdir -p /srv && echo \"Hello from ${var.secondary_region} (ci-ukw)\" > /srv/index.html && exec python3 -m http.server 80 --directory /srv"]

    ports {
      port     = 80
      protocol = "TCP"
    }
  }
}

# ── Traffic Manager: DNS-based failover ──────────────────────────────────

resource "azurerm_traffic_manager_profile" "lab" {
  name                   = "${var.name_prefix}-tm"
  resource_group_name    = azurerm_resource_group.lab.name
  traffic_routing_method = "Priority"
  tags                   = var.tags

  dns_config {
    relative_name = "${var.name_prefix}-tm"
    ttl           = 30
  }

  # Three failed checks 30 s apart mark an endpoint down: about 90 s, then
  # resolvers may hold the old answer for the 30 s TTL.
  monitor_config {
    protocol                     = "HTTP"
    port                         = 80
    path                         = "/"
    interval_in_seconds          = 30
    timeout_in_seconds           = 10
    tolerated_number_of_failures = 3
  }
}

# External endpoints: Traffic Manager sees the containers as any host on
# the internet, by name. The app ignores the Host header, so a browser
# asking for <prefix>-tm.trafficmanager.net is served.
resource "azurerm_traffic_manager_external_endpoint" "uks" {
  name       = "ep-uks"
  profile_id = azurerm_traffic_manager_profile.lab.id
  target     = azurerm_container_group.uks.fqdn
  priority   = 1
}

resource "azurerm_traffic_manager_external_endpoint" "ukw" {
  name       = "ep-ukw"
  profile_id = azurerm_traffic_manager_profile.lab.id
  target     = azurerm_container_group.ukw.fqdn
  priority   = 2
}

# ── Front Door Standard: anycast proxy failover ──────────────────────────

resource "azurerm_cdn_frontdoor_profile" "lab" {
  name                = "afd-lab"
  resource_group_name = azurerm_resource_group.lab.name
  sku_name            = "Standard_AzureFrontDoor"
  tags                = var.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "lab" {
  name                     = "${var.name_prefix}-afd"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id
  tags                     = var.tags
}

# Probes from Front Door's edge every 100 s; an origin is healthy when 3 of
# the last 4 probes passed.
resource "azurerm_cdn_frontdoor_origin_group" "lab" {
  name                     = "og-aci"
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

# Each origin is sent its own host name, as a real app would need.
resource "azurerm_cdn_frontdoor_origin" "uks" {
  name                           = "origin-uks"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.lab.id
  enabled                        = true
  host_name                      = azurerm_container_group.uks.fqdn
  origin_host_header             = azurerm_container_group.uks.fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
}

resource "azurerm_cdn_frontdoor_origin" "ukw" {
  name                           = "origin-ukw"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.lab.id
  enabled                        = true
  host_name                      = azurerm_container_group.ukw.fqdn
  origin_host_header             = azurerm_container_group.ukw.fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 2
  weight                         = 1000
  certificate_name_check_enabled = true
}

# Everything, over HTTP or HTTPS (Front Door's own certificate on
# *.azurefd.net), forwarded to the containers over HTTP. No cache block:
# every request reaches an origin, so a failover shows at once.
resource "azurerm_cdn_frontdoor_route" "lab" {
  name                          = "route-all"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.lab.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.lab.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.uks.id, azurerm_cdn_frontdoor_origin.ukw.id]
  patterns_to_match             = ["/*"]
  supported_protocols           = ["Http", "Https"]
  forwarding_protocol           = "HttpOnly"
  https_redirect_enabled        = false
  link_to_default_domain        = true
}
