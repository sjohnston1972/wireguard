# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the VNet the pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "pe-blob" = azurerm_private_endpoint.blob.private_service_connection[0].private_ip_address
  }
}

output "connect" {
  value = [
    "https://${azurerm_storage_account.blob.name}.blob.core.windows.net/${azurerm_storage_container.private.name}",
    "nslookup ${azurerm_storage_account.blob.name}.blob.core.windows.net",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
