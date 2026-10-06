# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The VM's address is reachable from tunnel clients while the lab is peered;
# peer_vnet_id is the VNet the pipeline peers to the gateway when asked. The
# connect lines include what the identities need on the VM: the vault's
# address and the user-assigned identity's client id.

output "private_ips" {
  value = {
    "vm-app" = azurerm_network_interface.vm.private_ip_address
  }
}

output "connect" {
  value = [
    "ssh azureuser@${azurerm_network_interface.vm.private_ip_address}",
    "vault: ${azurerm_key_vault.lab.vault_uri}",
    "user-assigned identity client_id: ${azurerm_user_assigned_identity.app.client_id}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
