# outputs.tf
#
# Plain English: what the dashboard shows once lab 04 is up (AWS labs spec §4, §10).

output "private_ips" {
  value = { "vm-data" = aws_instance.data.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.data.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.data.private_ip}",
    "aws s3api list-object-versions --bucket ${aws_s3_bucket.src.bucket} --prefix hello.txt",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
