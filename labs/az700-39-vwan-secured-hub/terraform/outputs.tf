# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Peering is off (a virtual hub cannot be peered with the gateway's VNet),
# so there is no peer_vnet_id: the VMs are reached through the portal's
# serial console or Run command, then from each other through the hub's
# firewall.

output "private_ips" {
  value = {
    "vm-spoke1" = azurerm_network_interface.spoke1.private_ip_address
    "vm-spoke2" = azurerm_network_interface.spoke2.private_ip_address
  }
}

output "connect" {
  value = [
    "serial console or Run command on vm-spoke1, then: ssh azureuser@${azurerm_network_interface.spoke2.private_ip_address}",
    "az network vhub get-effective-routes -g ${azurerm_resource_group.lab.name} -n vhub-lab --resource-type HubVirtualNetworkConnection --resource-id ${azurerm_virtual_hub_connection.spoke1.id}",
  ]
}
