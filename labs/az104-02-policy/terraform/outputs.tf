# outputs.tf
#
# Plain English: no VMs, so no addresses or connect lines.

output "private_ips" {
  value = {}
}

output "connect" {
  value = []
}
