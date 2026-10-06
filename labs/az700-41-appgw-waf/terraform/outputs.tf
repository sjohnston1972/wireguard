# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Everything is private: tunnel clients reach the gateway's private
# frontend and the VMs while the lab is peered, and resolve
# app.lab41.internal through the gateway's tunnel DNS (dns_link).
# peer_vnet_id is the VNet the pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "vm-web1" = azurerm_network_interface.web1.private_ip_address
    "vm-web2" = azurerm_network_interface.web2.private_ip_address
    "agw-hub" = local.agw_ip
  }
}

output "connect" {
  value = [
    "curl -ki https://app.lab41.internal/   # self-signed: -k",
    "curl -i http://app.lab41.internal/   # 301 to https",
    "curl -k 'https://app.lab41.internal/?attack=1'   # 403 from the WAF's custom rule",
    "curl -k https://${local.agw_ip}/   # the same, by address",
    "ssh azureuser@${azurerm_network_interface.web1.private_ip_address}",
    "vault: ${azurerm_key_vault.lab.vault_uri}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.hub.id
}
