# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# No VNet, so no private addresses and nothing to peer; connect names the
# two accounts, whose names end in a random part.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "${azurerm_storage_account.hot.name}: LRS, Hot, container samples (hello.txt)",
    "${azurerm_storage_account.cool.name}: GRS, Cool",
  ]
}
