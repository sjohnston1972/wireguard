# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is vnet-azure: the pipeline peers only that VNet with the
# gateway, so a tunnel client reaches vm-azure directly and vm-onprem only
# from vm-azure, across the site-to-site VPN. The BGP addresses are the
# ones each gateway peers with (list-bgp-peer-status shows them).

output "private_ips" {
  value = {
    "vm-azure"           = azurerm_network_interface.azure.private_ip_address
    "vm-onprem"          = azurerm_network_interface.onprem.private_ip_address
    "vpngw-azure (BGP)"  = try(azurerm_virtual_network_gateway.azure.bgp_settings[0].peering_addresses[0].default_addresses[0], "")
    "vpngw-onprem (BGP)" = try(azurerm_virtual_network_gateway.onprem.bgp_settings[0].peering_addresses[0].default_addresses[0], "")
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.azure.private_ip_address}",
    "from vm-azure, over the VPN: ssh azureuser@${azurerm_network_interface.onprem.private_ip_address}",
    "from vm-azure: curl http://${azurerm_network_interface.onprem.private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.azure.id
}
