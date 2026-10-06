# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# No VNet, so no private addresses and nothing to peer; connect names the
# two accounts (their names end in a random part) and the records account's
# read-only secondary endpoint.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "${azurerm_storage_account.lake.primary_dfs_endpoint}: data lake, file systems raw and curated",
    "${azurerm_storage_account.records.primary_blob_endpoint}evidence: 1-day retention, unlocked",
    "${azurerm_storage_account.records.secondary_blob_endpoint}: read-only copy (RA-GRS)",
  ]
}
