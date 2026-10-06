# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub ("Azure"): the pipeline peers only that VNet with
# the gateway, so a tunnel client reaches vm-app directly and vm-dns only
# from vm-app (peering is not transitive).

output "private_ips" {
  value = {
    "vm-app"           = azurerm_network_interface.app.private_ip_address
    "vm-dns"           = azurerm_network_interface.dns.private_ip_address
    "inbound-endpoint" = azurerm_private_dns_resolver_inbound_endpoint.in.ip_configurations[0].private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.app.private_ip_address}",
    "from vm-app: dig fileserver.onprem.lab32.internal",
    "from vm-app: ssh azureuser@${azurerm_network_interface.dns.private_ip_address}",
    "from vm-dns: dig vm-app.azure.lab32.internal",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
