# main.tf
#
# Plain English: two storage accounts side by side so the differences are
# easy to see. "hot" is locally redundant (LRS, three copies in one
# datacentre) with the Hot access tier; "cool" is geo-redundant (GRS, a
# second copy in the paired region) with the Cool tier. The hot account has
# a private container with one small blob and a lifecycle policy (block
# blobs move to Cool after 30 days without a change and are deleted after
# 365). Both accounts hold a few kilobytes, so the bill is a fraction of a
# penny an hour. No network, no VM, no Entra objects.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_storage_account" "hot" {
  name                            = "${var.name_prefix}hot"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_storage_account" "cool" {
  name                            = "${var.name_prefix}cool"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "GRS"
  access_tier                     = "Cool"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

# Made through Azure Resource Manager (storage_account_id), not the data plane.
resource "azurerm_storage_container" "samples" {
  name                  = "samples"
  storage_account_id    = azurerm_storage_account.hot.id
  container_access_type = "private"
}

# The one blob. Uploading it is the only data-plane call (account key, over
# the account's public endpoint, which this lab leaves open).
resource "azurerm_storage_blob" "hello" {
  name                 = "hello.txt"
  storage_container_id = azurerm_storage_container.samples.id
  type                 = "Block"
  content_type         = "text/plain"
  source_content       = "Hello from ${var.resource_group_name}. Change my access tier, then read the lifecycle rule that would do it for you.\n"
}

resource "azurerm_storage_management_policy" "hot" {
  storage_account_id = azurerm_storage_account.hot.id

  rule {
    name    = "cool-at-30-delete-at-365"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than = 30
        delete_after_days_since_modification_greater_than       = 365
      }
    }
  }
}
