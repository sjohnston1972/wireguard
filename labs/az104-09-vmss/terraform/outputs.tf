# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Scale set instances come and go, so their addresses are not outputs: the
# connect lines say how to list them (the portal's Instances blade shows
# them too). peer_vnet_id is the VNet the pipeline peers to the gateway.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "az vmss nic list -g ${azurerm_resource_group.lab.name} --vmss-name ${azurerm_linux_virtual_machine_scale_set.web.name} --query [].ipConfigurations[0].privateIPAddress -o tsv",
    "ssh azureuser@<instance address>",
    "curl http://<instance address>",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
