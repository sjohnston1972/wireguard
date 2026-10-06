# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The two prefixes are shown too, so a curl to an echo service from each VM
# can be matched to the way out it took. peer_vnet_id is the hub, the only
# VNet: a tunnel client reaches both VMs while the lab is peered.

output "private_ips" {
  value = {
    "vm-nat" = azurerm_network_interface.nat.private_ip_address
    "vm-lb"  = azurerm_network_interface.lb.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.nat.private_ip_address}",
    "ssh azureuser@${azurerm_network_interface.lb.private_ip_address}",
    "pfx-nat (NAT gateway): ${azurerm_public_ip_prefix.nat.ip_prefix}",
    "pfx-lb (outbound rule): ${azurerm_public_ip_prefix.lb.ip_prefix}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
