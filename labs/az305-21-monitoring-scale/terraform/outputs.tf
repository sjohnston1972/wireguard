# outputs.tf
#
# Plain English: no VMs, so no addresses. The connect lines are the CLI
# checks that show policy at work, once it has had its 15 minutes.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "az monitor diagnostic-settings list --resource ${azurerm_key_vault.lab.id} -o table",
    "az policy state list -g ${azurerm_resource_group.lab.name} -o table",
  ]
}
