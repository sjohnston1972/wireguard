# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# SSH goes through Bastion (the portal's Connect, Bastion); from a tunnel
# client, while peered, only port 80 on vm-web answers: the NSGs refuse SSH
# from anywhere but the Bastion subnet. peer_vnet_id is the VNet the
# pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "vm-web" = azurerm_network_interface.web.private_ip_address
    "vm-app" = azurerm_network_interface.app.private_ip_address
  }
}

output "connect" {
  value = [
    "Portal: vm-web or vm-app, Connect, Bastion (user azureuser, the password behind Show)",
    "curl http://${azurerm_network_interface.web.private_ip_address}   # vm-web, from a tunnel client while peered",
    "flow log: lab-${var.lab_id}-vnet in NetworkWatcherRG; blobs in ${azurerm_storage_account.flow.name}, container insights-logs-flowlogflowevent",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
