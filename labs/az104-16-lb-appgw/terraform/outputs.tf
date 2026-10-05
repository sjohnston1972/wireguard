# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Both frontends are private: tunnel clients reach them while the lab is
# peered. peer_vnet_id is the VNet the pipeline peers to the gateway when
# asked.

output "private_ips" {
  value = {
    "vm-web1" = azurerm_network_interface.web[0].private_ip_address
    "vm-web2" = azurerm_network_interface.web[1].private_ip_address
    "lbi-web" = local.lb_ip
    "agw-web" = local.appgw_ip
  }
}

output "connect" {
  value = [
    "curl http://${local.lb_ip}",
    "curl http://${local.appgw_ip}",
    "ssh azureuser@${azurerm_network_interface.web[0].private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
