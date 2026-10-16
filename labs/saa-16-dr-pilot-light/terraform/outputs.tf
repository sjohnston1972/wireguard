# outputs.tf
#
# Plain English: what the dashboard shows once lab 16 is up: the London app's
# address and the Ireland standby address, and the lines for the Things to
# try: connect, resolve the failover name, launch the DR instance, and check
# the data reached Ireland.

output "private_ips" {
  value = { "vm-app" = aws_instance.app.private_ip, "Ireland standby (when launched)" = local.dr_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user labadmin --connection-type eice",
    "getent hosts app.${aws_route53_zone.dr.name}",
    "aws ec2 run-instances --region ${var.secondary_region} --launch-template LaunchTemplateId=${aws_launch_template.dr.id},Version='$Latest' --network-interfaces DeviceIndex=0,SubnetId=${aws_subnet.dr.id},PrivateIpAddress=${local.dr_ip},Groups=${aws_security_group.dr.id}",
    "aws dynamodb put-item --region ${var.region} --table-name ${aws_dynamodb_table.orders.name} --item '{\"id\":{\"S\":\"o-1\"}}' && sleep 2 && aws dynamodb get-item --region ${var.secondary_region} --table-name ${aws_dynamodb_table.orders.name} --key '{\"id\":{\"S\":\"o-1\"}}'",
    "echo hi | aws s3 cp - s3://${aws_s3_bucket.london.bucket}/hi.txt && sleep 30 && aws s3api head-object --bucket ${aws_s3_bucket.london.bucket} --key hi.txt --query ReplicationStatus",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
