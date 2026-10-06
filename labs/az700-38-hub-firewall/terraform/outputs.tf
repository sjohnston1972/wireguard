# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is the hub. The spokes send everything to the firewall, which
# lets in only spoke-to-spoke SSH and ping, so the VMs are reached through
# the portal's serial console or Run command, then from each other.

output "private_ips" {
  value = {
    "vm-spoke1" = azurerm_network_interface.spoke1.private_ip_address
    "vm-spoke2" = azurerm_network_interface.spoke2.private_ip_address
    "afw-hub"   = azurerm_firewall.hub.ip_configuration[0].private_ip_address
  }
}

output "connect" {
  value = [
    "serial console or Run command on vm-spoke1, then: ssh azureuser@${azurerm_network_interface.spoke2.private_ip_address}",
    "from vm-spoke1: curl -sI https://www.microsoft.com (allowed) and curl -sI https://example.com (denied)",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
