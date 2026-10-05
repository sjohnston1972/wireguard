# main.tf
#
# Plain English: one Azure Cosmos DB for NoSQL account to practise
# partitioning and consistency on (spec §17, ruling 33).
#
#   <prefix>-cosmos   serverless (billed per request unit and GB stored,
#                     nothing provisioned), one region, Session consistency,
#                     the free tier off (one per subscription, and creation
#                     fails if another account already has it)
#     shop            a database with no throughput of its own
#       orders        partition key /customerId: many values, spread evenly
#       events        hierarchical key /tenantId then /userId (MultiHash), so
#                     one big tenant can grow past a logical partition's 20 GB
#       bykey-status  partition key /status: a handful of values, the
#                     deliberate hot-partition example
#
# The account is public with key authentication on, so the portal's Data
# Explorer works from anywhere; there is no network to peer.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_cosmosdb_account" "lab" {
  name                          = "${var.name_prefix}-cosmos"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  offer_type                    = "Standard"
  kind                          = "GlobalDocumentDB"
  free_tier_enabled             = false
  public_network_access_enabled = true
  local_authentication_enabled  = true
  tags                          = var.tags

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  # Serverless accounts run in one region.
  geo_location {
    location          = azurerm_resource_group.lab.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "shop" {
  name                = "shop"
  resource_group_name = azurerm_resource_group.lab.name
  account_name        = azurerm_cosmosdb_account.lab.name
}

# ── Three containers, three partition key designs ─────────────────────────

resource "azurerm_cosmosdb_sql_container" "orders" {
  name                  = "orders"
  resource_group_name   = azurerm_resource_group.lab.name
  account_name          = azurerm_cosmosdb_account.lab.name
  database_name         = azurerm_cosmosdb_sql_database.shop.name
  partition_key_paths   = ["/customerId"]
  partition_key_version = 2
}

resource "azurerm_cosmosdb_sql_container" "events" {
  name                  = "events"
  resource_group_name   = azurerm_resource_group.lab.name
  account_name          = azurerm_cosmosdb_account.lab.name
  database_name         = azurerm_cosmosdb_sql_database.shop.name
  partition_key_paths   = ["/tenantId", "/userId"]
  partition_key_kind    = "MultiHash"
  partition_key_version = 2
}

resource "azurerm_cosmosdb_sql_container" "by_status" {
  name                  = "bykey-status"
  resource_group_name   = azurerm_resource_group.lab.name
  account_name          = azurerm_cosmosdb_account.lab.name
  database_name         = azurerm_cosmosdb_sql_database.shop.name
  partition_key_paths   = ["/status"]
  partition_key_version = 2
}
