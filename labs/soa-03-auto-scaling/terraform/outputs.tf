# outputs.tf
#
# Plain English: what the dashboard shows once lab 03 is up. The group's
# instances come and go, so there are no fixed addresses: the Connect lines
# are the ALB's address and how to find an instance to connect to.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl http://${aws_lb.web.dns_name}",
    "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${aws_autoscaling_group.web.name} --query 'AutoScalingGroups[0].Instances[].InstanceId'",
    "aws ec2-instance-connect ssh --instance-id <an instance id from the group> --os-user labadmin --connection-type eice",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
