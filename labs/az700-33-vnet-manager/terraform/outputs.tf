# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub: the pipeline peers it with the gateway, but the
# spokes are reached from the hub only through AVNM's own peerings, which a
# tunnel client cannot cross (peering is not transitive). Use the portal's
# serial console or Run command on the spoke VMs; from one spoke the other
# answers directly (DirectlyConnected).

output "private_ips" {
  value = {
    "vm-spoke1" = azurerm_network_interface.spoke1.private_ip_address
    "vm-spoke2" = azurerm_network_interface.spoke2.private_ip_address
  }
}

output "connect" {
  value = [
    "vm-spoke1: portal, Serial console (user azureuser)",
    "from vm-spoke1: curl http://${azurerm_network_interface.spoke2.private_ip_address}",
    "from vm-spoke1: ssh azureuser@${azurerm_network_interface.spoke2.private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
