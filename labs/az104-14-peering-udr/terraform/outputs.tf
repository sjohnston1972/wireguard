# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub: the pipeline peers only that VNet with the
# gateway, so a tunnel client reaches vm-router directly and the spoke VMs
# only from vm-router (peering is not transitive).

output "private_ips" {
  value = {
    "vm-router" = azurerm_network_interface.router.private_ip_address
    "vm-spoke1" = azurerm_network_interface.spoke1.private_ip_address
    "vm-spoke2" = azurerm_network_interface.spoke2.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.router.private_ip_address}",
    "from vm-router: ssh azureuser@${azurerm_network_interface.spoke1.private_ip_address}",
    "from vm-spoke1: curl http://${azurerm_network_interface.spoke2.private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
