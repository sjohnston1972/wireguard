output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}

output "private_ips" {
  value = {}
}

output "connect" {
  value = "Download the VPN profile from vgw-hub"
}
