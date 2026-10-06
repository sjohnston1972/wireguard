# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The three load balancers' public addresses answer from anywhere on port 80
# (and lb-uks on 8081 for the NAT rule); the VMs' private addresses in
# vnet-uks are reachable from tunnel clients while the lab is peered.
# peer_vnet_id is vnet-uks, the VNet the pipeline peers to the gateway when
# asked; vnet-ukw is never peered.

output "private_ips" {
  value = {
    "vm-web1" = azurerm_network_interface.web1.private_ip_address
    "vm-nva"  = azurerm_network_interface.nva.private_ip_address
    "vm-web2" = azurerm_network_interface.web2.private_ip_address
    "lb-gw"   = local.gw_ip
  }
}

output "connect" {
  value = [
    "curl http://${azurerm_public_ip.global.ip_address}   # lb-global: the nearest healthy region",
    "curl http://${azurerm_public_ip.uks.ip_address}   # lb-uks (through lb-gw and vm-nva)",
    "curl http://${azurerm_public_ip.ukw.ip_address}   # lb-ukw",
    "curl http://${azurerm_public_ip.uks.ip_address}:8081   # lb-uks's inbound NAT rule to vm-web1",
    "ssh azureuser@${azurerm_network_interface.nva.private_ip_address}   # vm-nva: sudo tcpdump -ni eth0 udp portrange 10800-10801",
    "ssh azureuser@${azurerm_network_interface.web1.private_ip_address}   # vm-web1",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.uks.id
}
