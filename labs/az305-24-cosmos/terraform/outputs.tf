# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# No VNet, so no private addresses and nothing to peer; connect names the
# account, whose name ends in a random part. Keys stay in the portal.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    azurerm_cosmosdb_account.lab.endpoint,
    "${azurerm_cosmosdb_account.lab.name}: Data Explorer, database shop (orders, events, bykey-status)",
  ]
}
