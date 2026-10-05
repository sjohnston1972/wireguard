# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The ACI group's private address is reachable from tunnel clients while
# the lab is peered; the container app is public. peer_vnet_id is the VNet
# the pipeline peers to the gateway when asked.

output "private_ips" {
  value = {
    "aci-hello" = azurerm_container_group.hello.ip_address
  }
}

output "connect" {
  value = [
    "curl http://${azurerm_container_group.hello.ip_address}",
    "https://${azurerm_container_app.hello.ingress[0].fqdn}",
    "az acr login -n ${azurerm_container_registry.acr.name}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
