output "peer_vnet_id" {
  value = azurerm_virtual_network.source.id
}

output "private_ips" {
  value = { vm = azurerm_network_interface.vm.private_ip_address }
}

output "connect" {
  value = "ssh azureuser@${azurerm_network_interface.vm.private_ip_address}"
}
