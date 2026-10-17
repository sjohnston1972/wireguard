# outputs.tf
#
# Plain English: what the dashboard shows once lab 29 is up: the three
# instances' addresses, console SSH to each (the Ireland ones with
# --region eu-west-1), the two pings that compare the paths from London,
# and, while peered, SSH and the page on vm-london. Only vpc-lab is peered
# to the VPN server.

output "private_ips" {
  value = { "vm-london" = aws_instance.london.private_ip, "vm-ireland-tgw" = aws_instance.ireland_tgw.private_ip, "vm-ireland-pcx" = aws_instance.ireland_pcx.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.london.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland_tgw.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland_pcx.id} --os-user labadmin --connection-type eice",
    "From vm-london: ping -c 10 ${aws_instance.ireland_tgw.private_ip} (by the transit gateways), ping -c 10 ${aws_instance.ireland_pcx.private_ip} (by the VPC peering)",
    "ssh labadmin@${aws_instance.london.private_ip}",
    "curl http://${aws_instance.london.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
