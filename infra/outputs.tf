# outputs.tf
#
# Plain English: what Terraform reports back when it finishes. The workflow
# reads these with "terraform output -json" and POSTs them to the Worker so the
# dashboard can show the new address. No private key ever appears here.

output "public_ip" {
  description = "The VM's public (WAN) address. wg.clydeford.net points at it."
  value       = azurerm_public_ip.wg.ip_address
}

output "public_ip6" {
  description = "The VM's IPv6 WAN address (full-tunnel clients leave from here), or empty."
  value       = local.ipv6 ? azurerm_public_ip.wg6[0].ip_address : ""
}

output "vm_private_ip" {
  description = "The VM's address inside the Azure VNet."
  value       = azurerm_network_interface.wg.private_ip_address
}

output "resource_group" {
  description = "Resource group holding everything. Gone after destroy."
  value       = azurerm_resource_group.wg.name
}

output "dns_name" {
  description = "The name clients dial."
  value       = cloudflare_dns_record.wg.name
}

output "wg_server_ip" {
  description = "The server's tunnel address."
  value       = local.wg_server_ip
}

output "loopback_ip" {
  description = "The VM's loopback test address. Ping it from a connected client."
  value       = var.loopback_ip
}

output "deployed_at" {
  description = "UTC timestamp of this apply."
  value       = timestamp()
}

output "test_vm_ip" {
  description = "The test VM's address in the workloads subnet, or empty."
  value       = var.test_vm ? azurerm_network_interface.test[0].private_ip_address : ""
}
