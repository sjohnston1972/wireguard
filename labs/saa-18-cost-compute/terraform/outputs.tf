# outputs.tf
#
# Plain English: what the dashboard shows once lab 18 is up. The group's
# instances come and go, so no fixed addresses: how to list them with their
# type and purchase option, today's Spot prices, and how to connect.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws ec2 describe-instances --region ${var.region} --filters Name=tag:aws:autoscaling:groupName,Values=${aws_autoscaling_group.mixed.name} Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,InstanceType,InstanceLifecycle,Placement.AvailabilityZone]' --output table",
    "aws ec2 describe-spot-price-history --region ${var.region} --instance-types t4g.micro t4g.small t3.micro --product-descriptions Linux/UNIX --start-time $(date -u +%Y-%m-%dT%H:%M:%S) --query 'SpotPriceHistory[].[InstanceType,AvailabilityZone,SpotPrice]' --output table",
    "aws ec2-instance-connect ssh --instance-id <an instance id from the first line> --os-user labadmin --connection-type eice",
    "curl -s localhost",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
