# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (AWS labs spec
# §4). private_ips: name -> address. connect: short lines, for example
# "aws ec2-instance-connect ssh --instance-id i-... --os-user labadmin
# --connection-type eice" (works anywhere) and, while peered, "ssh
# labadmin@10.64.64.10" and "curl http://10.64.64.10". peer_vpc_id: the VPC
# the pipeline peers to the VPN server's (the hub in a multi-VPC lab, which
# also carries the tag cloudlabs-peer = hub); peer_route_table_ids: the lab
# route tables that get the route back to var.gateway_cidr.

output "private_ips" {
  value = {}
}

output "connect" {
  value = []
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
