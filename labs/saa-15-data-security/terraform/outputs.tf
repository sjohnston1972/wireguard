# outputs.tf
#
# Plain English: what the dashboard shows once lab 15 is up: how to connect
# to the test instance, the S3 lines to run there, and the endpoint's id for
# the bucket policy you write by hand.

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws s3 cp s3://${aws_s3_bucket.data.bucket}/secret.txt - && aws s3api head-object --bucket ${aws_s3_bucket.data.bucket} --key secret.txt",
    "echo hi | aws s3 cp - s3://${aws_s3_bucket.data.bucket}/aes.txt --sse AES256",
    "the S3 endpoint for a bucket policy condition (aws:SourceVpce): ${aws_vpc_endpoint.s3.id}",
    "ssh labadmin@${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
