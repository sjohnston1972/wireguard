# outputs.tf
#
# Plain English: what the dashboard shows once lab 27 is up: both
# instances' addresses, console SSH to each, the two tests to run on vm-a
# (one domain allowed, one dropped), where the alerts land, and, while
# peered, vm-a (spoke A is the hub).

output "private_ips" {
  value = { "vm-a" = aws_instance.a.private_ip, "vm-b" = aws_instance.b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.a.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.b.id} --os-user labadmin --connection-type eice",
    "From vm-a: curl -sI --max-time 5 https://aws.amazon.com (allowed), curl -sI --max-time 5 https://example.com (dropped)",
    "aws s3 ls s3://${aws_s3_bucket.nfwlogs.bucket}/alerts/ --recursive",
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
