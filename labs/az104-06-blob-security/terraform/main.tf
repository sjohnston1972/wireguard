# main.tf
#
# Plain English: three ways into one blob container, side by side.
#   - Keys and SAS: the storage account keeps shared-key access on, so you
#     can make account, service and user delegation SAS tokens.
#   - RBAC: an Entra group, lab-<id>-readers, holds Storage Blob Data Reader
#     on the lab's resource group. Add yourself to it to read with your own
#     identity instead of a key.
#   - Network: a small VNet (the first /20 of the session's slot) with a
#     private endpoint for the blob service, and the
#     privatelink.blob.core.windows.net zone linked to that VNet. While the
#     lab is peered, the pipeline also links the zone to the gateway VNet,
#     so tunnel clients resolve the account to its private address.
# Public network access starts on (so the portal works from home); turning
# it off is one of the things to try. The container starts empty: Terraform
# never uses the blob endpoint (versions.tf), so you upload the first file.

locals {
  # The first /20 of the slot; the endpoints subnet is its first /24.
  vnet_cidr      = cidrsubnet(var.address_space, 2, 0)
  endpoints_cidr = cidrsubnet(local.vnet_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Storage ───────────────────────────────────────────────────────────────

resource "azurerm_storage_account" "blob" {
  name                            = "${var.name_prefix}blob"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  public_network_access_enabled   = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "private" {
  name                  = "private"
  storage_account_id    = azurerm_storage_account.blob.id
  container_access_type = "private"
}

# ── Network: VNet, private endpoint, private DNS ─────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "endpoints" {
  name                 = "snet-endpoints"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.endpoints_cidr]
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "lab" {
  name                  = "link-vnet-lab"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.lab.id
  registration_enabled  = false
  tags                  = var.tags
}

resource "azurerm_private_endpoint" "blob" {
  name                          = "pe-${azurerm_storage_account.blob.name}-blob"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-${azurerm_storage_account.blob.name}-blob"
  tags                          = var.tags

  private_service_connection {
    name                           = "psc-blob"
    private_connection_resource_id = azurerm_storage_account.blob.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  # Writes the endpoint's A record into the privatelink zone.
  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

# ── Identity: the readers group and its role ─────────────────────────────

resource "azuread_group" "readers" {
  display_name     = "lab-${var.lab_id}-readers"
  description      = "wg-admin lab ${var.lab_id}: Storage Blob Data Reader on ${var.resource_group_name}. Removed at tear-down."
  security_enabled = true
}

resource "azurerm_role_assignment" "readers" {
  scope                = azurerm_resource_group.lab.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azuread_group.readers.object_id
  principal_type       = "Group"
}
