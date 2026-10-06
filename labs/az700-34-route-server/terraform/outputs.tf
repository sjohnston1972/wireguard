# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub: a tunnel client reaches vm-nva directly and
# vm-app only from the hub (peering is not transitive).

output "private_ips" {
  value = {
    "vm-nva"     = azurerm_network_interface.nva.private_ip_address
    "vm-app"     = azurerm_network_interface.app.private_ip_address
    "advertised" = local.advertised_ip
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.nva.private_ip_address}",
    "on vm-nva: sudo vtysh -c 'show ip bgp summary'",
    "from vm-nva: ssh azureuser@${azurerm_network_interface.app.private_ip_address}",
    "from vm-app: ping ${local.advertised_ip}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
