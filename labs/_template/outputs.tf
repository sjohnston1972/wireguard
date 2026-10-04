# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# private_ips: name -> address. connect: short lines such as
# "ssh azureuser@10.64.64.4". A lab that can peer also outputs peer_vnet_id
# (its first, "hub", VNet), and a lab that creates Entra users outputs users
# (name -> user principal name), shown behind Show with the admin password.

output "private_ips" {
  value = {}
}

output "connect" {
  value = []
}
