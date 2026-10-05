# main.tf
#
# Plain English: Azure SQL Database across two regions (spec §17, ruling 24).
#
#   rg-lab-<id> (the session's region, uksouth)
#     <prefix>-sqlp   logical server, SQL login labadmin
#       appdb         Basic (DTU): the primary. uksouth's vCore quota is 0, so
#                     nothing vCore lives here.
#     vnet-lab        the first /20 of the slot, with snet-pe, holding a
#                     private endpoint for EACH server, so both are reachable
#                     over the tunnel before and after a failover
#     privatelink.database.windows.net, linked to vnet-lab (and, while the
#                     lab is peered, to the gateway VNet by the pipeline,
#                     never by this Terraform)
#
#   rg-lab-<id>-secondary (the secondary region, ukwest)
#     <prefix>-sqls   logical server
#       appdb         Basic geo-secondary of the primary (create_mode Secondary)
#       scratch       General Purpose serverless (GP_S_Gen5_1, 0.5 to 1 vCore),
#                     pausing after 15 idle minutes; not geo-replicated, as
#                     auto-pause is not available to a geo-replicated database
#
#   <prefix>-fog      failover group on the primary server over appdb, with
#                     customer-managed (Manual) failover. Its listener,
#                     <prefix>-fog.database.windows.net, always names
#                     whichever server is primary.
#
# The servers allow public network access but have no firewall rules, so
# only the private endpoints reach them until you add a rule.

locals {
  # The first /20 of the slot; the private endpoints' subnet is its first /24.
  vnet_cidr      = cidrsubnet(var.address_space, 2, 0)
  endpoints_cidr = cidrsubnet(local.vnet_cidr, 4, 0)
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

# ── Servers: one per region ──────────────────────────────────────────────

resource "azurerm_mssql_server" "primary" {
  name                          = "${var.name_prefix}-sqlp"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  version                       = "12.0"
  administrator_login           = "labadmin"
  administrator_login_password  = var.admin_password
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true
  tags                          = var.tags
}

resource "azurerm_mssql_server" "secondary" {
  name                          = "${var.name_prefix}-sqls"
  resource_group_name           = azurerm_resource_group.secondary.name
  location                      = azurerm_resource_group.secondary.location
  version                       = "12.0"
  administrator_login           = "labadmin"
  administrator_login_password  = var.admin_password
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true
  tags                          = var.tags
}

# ── appdb: a Basic primary and its explicit Basic geo-secondary ──────────

resource "azurerm_mssql_database" "primary" {
  name      = "appdb"
  server_id = azurerm_mssql_server.primary.id
  sku_name  = "Basic"
  tags      = var.tags
}

resource "azurerm_mssql_database" "secondary" {
  name                        = "appdb"
  server_id                   = azurerm_mssql_server.secondary.id
  sku_name                    = "Basic"
  create_mode                 = "Secondary"
  creation_source_database_id = azurerm_mssql_database.primary.id
  tags                        = var.tags
}

# ── The failover group: Manual, over appdb ───────────────────────────────

resource "azurerm_mssql_failover_group" "fog" {
  name      = "${var.name_prefix}-fog"
  server_id = azurerm_mssql_server.primary.id
  databases = [azurerm_mssql_database.primary.id]
  tags      = var.tags

  partner_server {
    id = azurerm_mssql_server.secondary.id
  }

  # Customer-managed: nothing fails over until you ask (Microsoft-managed
  # failover needs a grace period of at least an hour).
  read_write_endpoint_failover_policy {
    mode = "Manual"
  }

  # appdb already has its geo-secondary: the group adopts that link. Made
  # after it, and destroyed before it.
  depends_on = [azurerm_mssql_database.secondary]
}

# ── scratch: serverless, in the secondary region only ────────────────────

resource "azurerm_mssql_database" "scratch" {
  name                        = "scratch"
  server_id                   = azurerm_mssql_server.secondary.id
  sku_name                    = "GP_S_Gen5_1"
  min_capacity                = 0.5
  auto_pause_delay_in_minutes = 15
  max_size_gb                 = 1
  tags                        = var.tags
}

# ── Network: VNet, private endpoints, private DNS ────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "endpoints" {
  name                 = "snet-pe"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.endpoints_cidr]
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

# Both endpoints sit in uksouth, the secondary server's too (an endpoint may
# reach a resource in another region), so the tunnel reaches both servers.
resource "azurerm_private_endpoint" "primary" {
  name                          = "pe-${azurerm_mssql_server.primary.name}"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-${azurerm_mssql_server.primary.name}"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-sqlp"
    private_connection_resource_id = azurerm_mssql_server.primary.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }

  # Writes the endpoint's A record into the privatelink zone.
  private_dns_zone_group {
    name                 = "sql"
    private_dns_zone_ids = [azurerm_private_dns_zone.sql.id]
  }
}

resource "azurerm_private_endpoint" "secondary" {
  name                          = "pe-${azurerm_mssql_server.secondary.name}"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-${azurerm_mssql_server.secondary.name}"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-sqls"
    private_connection_resource_id = azurerm_mssql_server.secondary.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "sql"
    private_dns_zone_ids = [azurerm_private_dns_zone.sql.id]
  }
}
