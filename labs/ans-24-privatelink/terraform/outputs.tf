# outputs.tf
#
# Plain English: what the dashboard shows once lab 24 is up: the two
# instances, how to connect to each, the service by its private name and by
# the endpoint's own name, the S3 read through the gateway endpoint, and,
# while peered, SSH and the page on vm-consumer. vpc-lab is the hub.

output "private_ips" {
  value = { "vm-consumer" = aws_instance.consumer.private_ip, "vm-provider" = aws_instance.provider.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.consumer.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.provider.id} --os-user labadmin --connection-type eice",
    "From vm-consumer: curl http://app.${local.svc_domain}",
    "From vm-consumer: curl http://${aws_vpc_endpoint.svc.dns_entry[0].dns_name}",
    "From vm-consumer: aws s3 cp s3://${local.data_bucket}/hello.txt - --region ${var.region}",
    "ssh labadmin@${aws_instance.consumer.private_ip}",
    "curl http://${aws_instance.consumer.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
