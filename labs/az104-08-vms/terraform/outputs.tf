# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The VMs' addresses are reachable from tunnel clients while the lab is
# peered; peer_vnet_id is the VNet the pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "vm-zone1" = azurerm_network_interface.zone1.private_ip_address
    "vm-zone2" = azurerm_network_interface.zone2.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.zone1.private_ip_address}",
    "ssh azureuser@${azurerm_network_interface.zone2.private_ip_address}",
    "curl http://${azurerm_network_interface.zone1.private_ip_address}",
    "curl http://${azurerm_network_interface.zone2.private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
