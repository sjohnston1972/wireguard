# main.tf
#
# Plain English: a three-tier web app with no App Service and no vCore
# database (spec §17, ruling 41: the subscription's App Service quota is 0,
# and so is its SQL vCore quota in uksouth). Everything is in rg-lab-<id>,
# apart from the group the Container Apps platform makes for itself, which
# is named rg-lab-<id>-infra so the sweep finds it.
#
#   Front Door Standard (global)  afd-lab, one endpoint, one route for /*,
#                                 HTTPS to one origin: the web tier. A WAF
#                                 policy (Prevention) of custom rules only:
#                                 block /admin, rate-limit each client.
#                                 Managed rule sets need Premium.
#   web tier   ca-web             a Container App with public HTTPS ingress
#                                 that refuses any request without this
#                                 profile's X-Azure-FDID header (403), so it
#                                 answers only through Front Door. Scales to
#                                 zero. Calls the app tier at http://ca-app.
#   app tier   ca-app             a Container App with internal ingress only:
#                                 an API container (Python) and a sqlcmd
#                                 sidecar sharing an EmptyDir volume. The SQL
#                                 password reaches it only as a Container Apps
#                                 secret, never an output.
#   data tier  <prefix>-sql/appdb Azure SQL Database Basic (DTU), public
#                                 network access off, one private endpoint in
#                                 snet-pe and privatelink.database.windows.net
#                                 linked to vnet-lab.
#
# Both apps run in cae-lab, a workload-profiles environment (the Consumption
# profile only: no Dedicated plan management fee) in snet-apps, delegated to
# Microsoft.App/environments, so the app tier reaches the private endpoint.
# Every image comes from MCR through the subnet's default outbound access.

locals {
  # The first /20 of the slot; the environment's subnet is its first /24 and
  # the private endpoint's its second.
  vnet_cidr      = cidrsubnet(var.address_space, 2, 0)
  apps_cidr      = cidrsubnet(local.vnet_cidr, 4, 0)
  endpoints_cidr = cidrsubnet(local.vnet_cidr, 4, 1)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network: the environment's subnet and the private endpoint's ─────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.apps_cidr]
  # A delegated service subnet keeps default outbound (ruling 57): the
  # environment pulls its images from MCR.
  default_outbound_access_enabled = true

  delegation {
    name = "containerapps"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                 = "snet-pe"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.endpoints_cidr]
  # Nothing here needs the internet (ruling 57).
  default_outbound_access_enabled = false
}

# ── Data tier: Azure SQL Database Basic, private only ────────────────────

resource "azurerm_mssql_server" "lab" {
  name                          = "${var.name_prefix}-sql"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  version                       = "12.0"
  administrator_login           = "labadmin"
  administrator_login_password  = var.admin_password
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false
  tags                          = var.tags
}

resource "azurerm_mssql_database" "app" {
  name      = "appdb"
  server_id = azurerm_mssql_server.lab.id
  sku_name  = "Basic"
  tags      = var.tags
}

resource "azurerm_private_dns_zone" "sql" {
  name                = "privatelink.database.windows.net"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "lab" {
  name                  = "link-vnet-lab"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.sql.name
  virtual_network_id    = azurerm_virtual_network.lab.id
  registration_enabled  = false
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "sql" {
  name                          = "pe-${azurerm_mssql_server.lab.name}"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-${azurerm_mssql_server.lab.name}"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-sql"
    private_connection_resource_id = azurerm_mssql_server.lab.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }

  # Writes the endpoint's A record into the privatelink zone.
  private_dns_zone_group {
    name                 = "sql"
    private_dns_zone_ids = [azurerm_private_dns_zone.sql.id]
  }
}

# ── The Container Apps environment: workload profiles, in snet-apps ──────

resource "azurerm_container_app_environment" "lab" {
  name                     = "cae-lab"
  resource_group_name      = azurerm_resource_group.lab.name
  location                 = azurerm_resource_group.lab.location
  infrastructure_subnet_id = azurerm_subnet.apps.id
  # Azure makes this group for the environment's load balancer and public
  # IPs, and deletes it with the environment (ruling 7: named rg-lab-<id>-*).
  infrastructure_resource_group_name = "${var.resource_group_name}-infra"
  internal_load_balancer_enabled     = false
  zone_redundancy_enabled            = false
  tags                               = var.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

# ── App tier: internal ingress, an API and a sqlcmd sidecar ──────────────

resource "azurerm_container_app" "app" {
  name                         = "ca-app"
  container_app_environment_id = azurerm_container_app_environment.lab.id
  resource_group_name          = azurerm_resource_group.lab.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = var.tags

  # The password as a Container Apps secret: the sidecar reads it through a
  # secret reference, and no output or plain setting carries it.
  secret {
    name  = "sql-password"
    value = var.admin_password
  }

  template {
    # One replica always: the sidecar keeps querying, and exec has a target.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "shared"
      storage_type = "EmptyDir"
    }

    container {
      name    = "api"
      image   = "mcr.microsoft.com/azurelinux/base/python:3.12"
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["python3", "-c", file("${path.module}/app.py")]

      env {
        name  = "SQL_SERVER"
        value = azurerm_mssql_server.lab.fully_qualified_domain_name
      }

      volume_mounts {
        name = "shared"
        path = "/shared"
      }
    }

    container {
      name    = "sqltools"
      image   = "mcr.microsoft.com/mssql/server:2022-latest"
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["/bin/bash", "-c", file("${path.module}/sqltools.sh")]

      env {
        name  = "SQLCMDSERVER"
        value = azurerm_mssql_server.lab.fully_qualified_domain_name
      }

      env {
        name  = "SQLCMDUSER"
        value = "labadmin"
      }

      env {
        name  = "SQLCMDDBNAME"
        value = "appdb"
      }

      env {
        name        = "SQLCMDPASSWORD"
        secret_name = "sql-password"
      }

      volume_mounts {
        name = "shared"
        path = "/shared"
      }
    }
  }

  # Internal: only apps in the environment (and its VNet) reach it. Plain
  # HTTP is allowed because the web tier calls http://ca-app inside it.
  ingress {
    external_enabled           = false
    allow_insecure_connections = true
    target_port                = 8080

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  # The sidecar's first query needs the endpoint and its DNS record.
  depends_on = [azurerm_private_endpoint.sql, azurerm_private_dns_zone_virtual_network_link.lab, azurerm_mssql_database.app]
}

# ── Web tier: public HTTPS ingress, answering only Front Door ────────────

resource "azurerm_container_app" "web" {
  name                         = "ca-web"
  container_app_environment_id = azurerm_container_app_environment.lab.id
  resource_group_name          = azurerm_resource_group.lab.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = var.tags

  template {
    # No replicas, and no charge, until Front Door sends a request.
    min_replicas = 0
    max_replicas = 1

    container {
      name    = "web"
      image   = "mcr.microsoft.com/azurelinux/base/python:3.12"
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["python3", "-c", file("${path.module}/web.py")]

      # Front Door puts this profile's id in X-Azure-FDID on every request.
      env {
        name  = "FRONT_DOOR_ID"
        value = azurerm_cdn_frontdoor_profile.lab.resource_guid
      }

      env {
        name  = "APP_URL"
        value = "http://ca-app"
      }
    }
  }

  # Public by nature (ruling 50): Front Door Standard reaches origins over
  # the internet. HTTPS only; the app itself refuses anything not from
  # this lab's Front Door.
  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 8080

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ── Front Door Standard and its WAF policy ───────────────────────────────

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

# One origin, so no health probe: probes from every edge would keep the web
# tier awake, and with one origin there is nothing to fail over to.
resource "azurerm_cdn_frontdoor_origin_group" "lab" {
  name                     = "og-web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.lab.id
  session_affinity_enabled = false

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }
}

# Container Apps routes by host name, so the origin is sent its own.
resource "azurerm_cdn_frontdoor_origin" "web" {
  name                           = "origin-web"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.lab.id
  enabled                        = true
  host_name                      = azurerm_container_app.web.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.web.ingress[0].fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
}

# HTTP in is redirected to HTTPS; Front Door talks HTTPS to the web tier.
resource "azurerm_cdn_frontdoor_route" "lab" {
  name                          = "route-all"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.lab.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.lab.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.web.id]
  patterns_to_match             = ["/*"]
  supported_protocols           = ["Http", "Https"]
  forwarding_protocol           = "HttpsOnly"
  https_redirect_enabled        = true
  link_to_default_domain        = true
}

# Standard takes custom rules (match, rate limit, geo) but no managed rule
# sets or bot protection: those need Premium.
resource "azurerm_cdn_frontdoor_firewall_policy" "lab" {
  name                              = "waflab"
  resource_group_name               = azurerm_resource_group.lab.name
  sku_name                          = "Standard_AzureFrontDoor"
  enabled                           = true
  mode                              = "Prevention"
  custom_block_response_status_code = 403
  custom_block_response_body        = base64encode("Blocked by the lab's WAF policy.\n")
  tags                              = var.tags

  # Anything under /admin is blocked at the edge, whatever its case.
  custom_rule {
    name     = "BlockAdminPath"
    enabled  = true
    priority = 10
    type     = "MatchRule"
    action   = "Block"

    match_condition {
      match_variable = "RequestUri"
      operator       = "Contains"
      match_values   = ["/admin"]
      transforms     = ["Lowercase"]
    }
  }

  # More than 100 requests in a minute from one client address is blocked.
  custom_rule {
    name                           = "RateLimitPerClient"
    enabled                        = true
    priority                       = 20
    type                           = "RateLimitRule"
    action                         = "Block"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 100

    # Every request counts. Any would match too, but Azure refuses match
    # values with Any and azurerm requires one, so Contains "/" (lab 42).
    match_condition {
      match_variable = "RequestUri"
      operator       = "Contains"
      match_values   = ["/"]
    }
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
