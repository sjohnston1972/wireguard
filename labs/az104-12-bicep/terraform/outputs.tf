# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Nothing here has a private address to reach and the lab cannot peer, so
# there is no peer_vnet_id; connect shows the template's outputs and how to
# read the deployment.

locals {
  template_outputs = jsondecode(azurerm_resource_group_template_deployment.bicep.output_content)
}

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "storage account: ${local.template_outputs.storageAccountName.value}",
    "subnets: ${join(", ", local.template_outputs.subnetPrefixes.value)}",
    "az deployment group show -g ${azurerm_resource_group.lab.name} -n ${azurerm_resource_group_template_deployment.bicep.name} --query properties.outputs",
  ]
}
