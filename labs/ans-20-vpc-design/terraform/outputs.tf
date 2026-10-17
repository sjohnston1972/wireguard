# outputs.tf
#
# Plain English: what the dashboard shows once lab 20 is up: vm-dual's IPv4
# address, console SSH to it, its IPv6 address (from the IPAM pool), and,
# while peered, SSH and the page from your PC. Both vpc-lab route tables get
# the pipeline's route back to the VPN server: rt-private and rt-dual (the
# gateway's /16 is more specific than rt-dual's default route to nat-lab).

output "private_ips" {
  value = { "vm-dual" = aws_instance.dual.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.dual.id} --os-user labadmin --connection-type eice",
    "IPv6: ${aws_instance.dual.ipv6_addresses[0]}",
    "ssh labadmin@${aws_instance.dual.private_ip}",
    "curl http://${aws_instance.dual.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id, aws_route_table.dual.id]
}
