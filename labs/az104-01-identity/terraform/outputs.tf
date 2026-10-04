# outputs.tf
#
# Plain English: no VMs, so no addresses or connect lines. users is what
# Show reveals beside the session password: ann and ben's sign-in names.

output "private_ips" {
  value = {}
}

output "connect" {
  value = []
}

output "users" {
  value = {
    ann = azuread_user.ann.user_principal_name
    ben = azuread_user.ben.user_principal_name
  }
}
