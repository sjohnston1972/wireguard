# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub: a tunnel client reaches vm-nva directly and
# vm-app only from vm-nva (peering is not transitive). vm-app's traffic to
# the hub uses the peering's own route, more specific than 0.0.0.0/0, so
# that part always works.

output "private_ips" {
  value = {
    "vm-nva" = azurerm_network_interface.nva.private_ip_address
    "vm-app" = azurerm_network_interface.app.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.nva.private_ip_address}",
    "from vm-nva: ssh azureuser@${azurerm_network_interface.app.private_ip_address}",
    "from vm-app: curl -I https://www.microsoft.com",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
