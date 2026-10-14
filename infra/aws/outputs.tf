# outputs.tf (AWS)
#
# Plain English: what Terraform reports back when it finishes. Same output names
# as the Azure root so the workflow and the Worker read either cloud the same way.
# No private key ever appears here.

output "public_ip" {
  description = "The server's public (WAN) address. wg.clydeford.net points at it."
  value       = aws_eip.wg.public_ip
}

output "public_ip6" {
  description = "The server's IPv6 WAN address, or empty."
  value       = local.ipv6 ? tolist(aws_network_interface.wg.ipv6_addresses)[0] : ""
}

output "vm_private_ip" {
  description = "The server's address inside the VPC."
  value       = aws_network_interface.wg.private_ip
}

output "resource_group" {
  description = "AWS has no resource groups here: everything is tagged wg-admin=vpn."
  value       = "wg-admin=vpn (${var.region})"
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
  description = "The server's loopback test address. Ping it from a connected client."
  value       = var.loopback_ip
}

output "deployed_at" {
  description = "UTC timestamp of this apply."
  value       = timestamp()
}

output "test_vm_ip" {
  description = "The test VM's address in the workloads subnet, or empty."
  value       = var.test_vm ? aws_instance.test[0].private_ip : ""
}
