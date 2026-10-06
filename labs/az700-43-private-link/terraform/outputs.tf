# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is vnet-consumer: while it is peered to the gateway, a tunnel
# client reaches vm-client and both private endpoints, and resolves
# <prefix>st's blob name to pe-blob through the tunnel's DNS (dns_link).
# vnet-provider is reached only through pls-svc, never peered.

output "private_ips" {
  value = {
    "vm-svc"    = azurerm_network_interface.svc.private_ip_address
    "lb-svc"    = local.lb_ip
    "vm-client" = azurerm_network_interface.client.private_ip_address
    "pe-svc"    = azurerm_private_endpoint.svc.private_service_connection[0].private_ip_address
    "pe-blob"   = azurerm_private_endpoint.blob.private_service_connection[0].private_ip_address
  }
}

output "connect" {
  value = [
    "curl http://${azurerm_private_endpoint.svc.private_service_connection[0].private_ip_address}   # vm-svc, through pe-svc and pls-svc",
    "ssh azureuser@${azurerm_network_interface.client.private_ip_address}   # vm-client",
    "nslookup ${azurerm_storage_account.st.name}.blob.core.windows.net   # pe-blob's address inside vnet-consumer",
    "curl -sI https://${azurerm_storage_account.other.name}.blob.core.windows.net/data   # from vm-client: refused by the service endpoint policy",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.consumer.id
}
