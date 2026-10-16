# outputs.tf
#
# Plain English: what the dashboard shows once lab 11 is up. The app tier's
# instances come and go, so there are no fixed addresses: the load
# balancer's address, how to find an app instance, and the two data-tier
# commands to run on one (the password is the session's, behind Show).

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl http://${aws_lb.web.dns_name}",
    "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${aws_autoscaling_group.web.name} --query 'AutoScalingGroups[0].Instances[].InstanceId'",
    "aws ec2-instance-connect ssh --instance-id <an app instance id> --os-user labadmin --connection-type eice",
    "mysql -h ${aws_db_instance.app.address} -u labadmin -p appdb",
    "valkey-cli -h ${aws_elasticache_replication_group.app.primary_endpoint_address} ping",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id, aws_route_table.data.id]
}
