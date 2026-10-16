# outputs.tf
#
# Plain English: what the dashboard shows once lab 08 is up (AWS labs spec
# §4, §10). The app VPC is the one peered to the VPN server's (the hub); the
# data VPC is reachable only from the app VPC, through its own peering.

output "private_ips" {
  value = { "vm-web" = aws_instance.web.private_ip, "vm-db" = aws_instance.db.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.web.id} --os-user labadmin --connection-type eice",
    "mysql -h ${aws_instance.db.private_ip} -u app -p shop   (on vm-web; the password is labadmin's)",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.db.id} --os-user labadmin --connection-type eice",
    "aws logs tail /cloudlabs/${var.lab_id}/flow --since 10m",
    "ssh labadmin@${aws_instance.web.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
