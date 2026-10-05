# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The VM's address is reachable from tunnel clients while the lab is peered;
# peer_vnet_id is the VNet the pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "vm-backup" = azurerm_network_interface.vm.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.vm.private_ip_address}",
    "echo precious > ~/precious.txt   # then Backup now, delete it, and get it back",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
