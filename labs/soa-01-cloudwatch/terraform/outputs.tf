# outputs.tf
#
# Plain English: what the dashboard shows once lab 01 is up (AWS labs spec §4, §10).

output "private_ips" {
  value = { "vm-app" = aws_instance.app.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.app.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
