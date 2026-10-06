# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# peer_vnet_id is vnet-hub, the VNet the pipeline peers with the gateway
# when asked. users is the Entra user to sign in to the VPN as (its password
# is the session's, behind Show).

output "private_ips" {
  value = {
    "vm-app" = azurerm_network_interface.app.private_ip_address
  }
}

output "connect" {
  value = [
    "connect the Azure VPN Client to vpngw-hub, then: ssh azureuser@${azurerm_network_interface.app.private_ip_address}",
    "curl http://${azurerm_network_interface.app.private_ip_address}",
    "VPN clients get addresses from ${local.p2s_pool}",
  ]
}

output "users" {
  value = {
    vpnuser = azuread_user.vpnuser.user_principal_name
  }
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
