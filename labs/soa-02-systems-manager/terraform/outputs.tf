# outputs.tf
#
# Plain English: what the dashboard shows once lab 02 is up (AWS labs spec §4, §10).

output "private_ips" {
  value = { "vm-web1" = aws_instance.web[0].private_ip, "vm-web2" = aws_instance.web[1].private_ip }
}

output "connect" {
  value = [
    "aws ssm start-session --target ${aws_instance.web[0].id}",
    "aws ssm start-session --target ${aws_instance.web[1].id}",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.web[0].id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.web[0].private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
