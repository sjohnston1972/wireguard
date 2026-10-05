# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The public zone is not delegated, so the first line asks one of its own
# name servers. The private names resolve on vm-web, and from tunnel
# clients while the lab is peered. peer_vnet_id is the VNet the pipeline
# peers to the gateway when asked.

output "private_ips" {
  value = {
    "vm-web" = azurerm_network_interface.web.private_ip_address
  }
}

output "connect" {
  value = [
    "nslookup www.${azurerm_dns_zone.public.name} ${tolist(azurerm_dns_zone.public.name_servers)[0]}",
    "nslookup vm-web.lab15.internal",
    "curl http://www.lab15.internal",
    "ssh azureuser@${azurerm_network_interface.web.private_ip_address}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
