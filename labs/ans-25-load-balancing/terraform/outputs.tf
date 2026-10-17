# outputs.tf
#
# Plain English: what the dashboard shows once lab 25 is up: the four
# instances' addresses; console SSH to the client and the appliance; the ALB's
# name and the NLB's fixed address for curl from anywhere (the certificate is
# self-signed, hence -k); and, while peered, vm-blue.

output "private_ips" {
  value = {
    "vm-blue"      = aws_instance.blue.private_ip
    "vm-green"     = aws_instance.green.private_ip
    "vm-client"    = aws_instance.client.private_ip
    "vm-appliance" = aws_instance.appliance.private_ip
  }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.appliance.id} --os-user labadmin --connection-type eice",
    "ALB: curl -k https://${aws_lb.alb.dns_name}/   (self-signed certificate: -k)",
    "NLB: curl -k https://${aws_eip.nlb.public_ip}/   (TLS 443)   and   curl http://${aws_eip.nlb.public_ip}:8080/   (proxy protocol)",
    "ssh labadmin@${aws_instance.blue.private_ip}",
    "curl http://${aws_instance.blue.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
