# main.tf
#
# Plain English: two storage accounts designed for two jobs (spec §17,
# ruling 34).
#
#   <prefix>lake   Data Lake Storage: StorageV2, LRS, Hot, hierarchical
#                  namespace on. File systems raw and curated. A lifecycle
#                  policy ages raw/ to Cool at 30 days, Cold at 90 and
#                  Archive at 180, and deletes curated/ at 365.
#   <prefix>rec    Records: StorageV2, RA-GRS (a read-only copy in the
#                  region's pair). Container evidence carries a time-based
#                  retention policy of 1 day, UNLOCKED, with protected
#                  append writes: blobs cannot be changed or deleted for a
#                  day, but the policy itself can still be deleted, so
#                  tear-down always gets back to £0. A locked policy is
#                  refused at plan; never lock one by hand.
#
# Nothing is written through the data plane (versions.tf): the containers
# start empty, you upload the first files. No SFTP (billed by the hour), no
# public containers, no version-level immutability.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The data lake ────────────────────────────────────────────────────────

resource "azurerm_storage_account" "lake" {
  name                            = "${var.name_prefix}lake"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  is_hns_enabled                  = true
  sftp_enabled                    = false
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  public_network_access_enabled   = true
  tags                            = var.tags
}

# With a hierarchical namespace, a container is a file system.
resource "azurerm_storage_container" "raw" {
  name                  = "raw"
  storage_account_id    = azurerm_storage_account.lake.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "curated" {
  name                  = "curated"
  storage_account_id    = azurerm_storage_account.lake.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "lake" {
  storage_account_id = azurerm_storage_account.lake.id

  rule {
    name    = "raw-cool-cold-archive"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["raw/"]
    }

    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than    = 30
        tier_to_cold_after_days_since_modification_greater_than    = 90
        tier_to_archive_after_days_since_modification_greater_than = 180
      }
    }
  }

  rule {
    name    = "curated-delete-after-a-year"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["curated/"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 365
      }
    }
  }
}

# ── The records account: RA-GRS and an unlocked retention policy ─────────

resource "azurerm_storage_account" "records" {
  name                            = "${var.name_prefix}rec"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "RAGRS"
  access_tier                     = "Hot"
  sftp_enabled                    = false
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  public_network_access_enabled   = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "evidence" {
  name                  = "evidence"
  storage_account_id    = azurerm_storage_account.records.id
  container_access_type = "private"
}

resource "azurerm_storage_container_immutability_policy" "evidence" {
  storage_container_resource_manager_id = azurerm_storage_container.evidence.id
  immutability_period_in_days           = 1
  protected_append_writes_enabled       = true
  # Never true: a locked policy cannot be deleted until every blob's
  # retention has run out, and the scope check refuses it.
  locked = false
}
