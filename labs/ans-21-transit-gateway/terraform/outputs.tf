# outputs.tf
#
# Plain English: what the dashboard shows once lab 21 is up: both test
# instances' addresses and console SSH to each, and, while peered, SSH and
# the page on vm-a. Only spoke A (vpc-lab) is peered to the VPN server: the
# gateway's /16 in rt-private is more specific than the default route to
# the transit gateway, so that traffic still takes the peering.

output "private_ips" {
  value = { "vm-a" = aws_instance.a.private_ip, "vm-b" = aws_instance.b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.a.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.b.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.a.private_ip}",
    "curl http://${aws_instance.a.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
