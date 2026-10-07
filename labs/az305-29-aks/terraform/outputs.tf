# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The node's address is AKS's to give (its scale set lives in the node
# resource group), so private_ips is empty: kubectl get nodes -o wide shows
# it. peer_vnet_id is the VNet the pipeline peers to the gateway when asked,
# so tunnel clients reach the node and internal load balancers in snet-aks.
# The connect lines are the commands the readme starts from.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "az aks get-credentials --resource-group ${azurerm_resource_group.lab.name} --name ${azurerm_kubernetes_cluster.aks.name}",
    "kubectl get nodes -o wide",
    "registry: ${azurerm_container_registry.acr.login_server}",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
