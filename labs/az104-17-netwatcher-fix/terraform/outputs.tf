# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Both VMs take ssh from the VNet, so a tunnel client reaches them while the
# lab is peered. peer_vnet_id is the VNet the pipeline peers to the gateway
# when asked.

output "private_ips" {
  value = {
    "vm-app" = azurerm_network_interface.app.private_ip_address
    "vm-db"  = azurerm_network_interface.db.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.app.private_ip_address}",
    "from vm-app: curl http://vm-db:8080",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
