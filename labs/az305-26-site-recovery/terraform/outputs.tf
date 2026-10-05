# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The VM's address is reachable from tunnel clients while the lab is peered
# (vnet-source is the VNet the pipeline peers to the gateway). After a
# failover the VM is in vnet-target, in the secondary region, which is not
# peered: reach it through the portal's serial console or Run command.

output "private_ips" {
  value = {
    "vm-app" = azurerm_network_interface.vm.private_ip_address
  }
}

output "connect" {
  value = [
    "curl http://${azurerm_network_interface.vm.private_ip_address}   # vm-app in ${azurerm_resource_group.lab.location}",
    "ssh azureuser@${azurerm_network_interface.vm.private_ip_address}",
    "Site Recovery: ${azurerm_recovery_services_vault.lab.name} in ${azurerm_resource_group.secondary.name} > Replicated items > vm-app",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.source.id
}
