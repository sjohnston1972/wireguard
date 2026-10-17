# outputs.tf
#
# Plain English: what the dashboard shows once lab 22 is up: both
# instances' private addresses, console SSH to each, the two commands that
# show the tunnels and the BGP sessions from the router's side, and, while
# peered, SSH and the page on vm-aws. Only vpc-lab is peered to the VPN
# server; rt-private also carries the route vgw-lab learns by BGP.

output "private_ips" {
  value = { "vm-aws" = aws_instance.aws.private_ip, "vm-router" = aws_instance.router.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.aws.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.router.id} --os-user labadmin --connection-type eice",
    "On vm-router: sudo swanctl --list-sas; sudo vtysh -c 'show ip bgp summary'",
    "ssh labadmin@${aws_instance.aws.private_ip}",
    "curl http://${aws_instance.aws.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
