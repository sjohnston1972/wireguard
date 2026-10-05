# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# vm-web answers tunnel clients while the lab is peered; vm-app answers only
# vm-web, on 8080. peer_vnet_id is the VNet the pipeline peers to the
# gateway when asked.

output "private_ips" {
  value = {
    "vm-web" = azurerm_network_interface.web.private_ip_address
    "vm-app" = azurerm_network_interface.app.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.web.private_ip_address}",
    "curl http://${azurerm_network_interface.web.private_ip_address}",
    "from vm-web: curl http://${azurerm_network_interface.app.private_ip_address}:8080",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
