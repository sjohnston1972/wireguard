# outputs.tf
#
# Plain English: what the dashboard shows once lab 28 is up (AWS labs spec
# §4, §10): the three instances' addresses, console SSH to each, the request
# that fails, the command that starts a mirror session from vm-svc to
# vm-monitor (tagged for the lab, so tear-down removes it), the flow log
# group to tail, and, while peered, vm-client (the client VPC is the hub).

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip, "vm-svc" = aws_instance.svc.private_ip, "vm-monitor" = aws_instance.monitor.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "From vm-client: curl --max-time 5 http://${aws_lb.svc.dns_name}",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.svc.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.monitor.id} --os-user labadmin --connection-type eice",
    "aws ec2 create-traffic-mirror-session --network-interface-id ${aws_instance.svc.primary_network_interface_id} --traffic-mirror-target-id ${aws_ec2_traffic_mirror_target.monitor.id} --traffic-mirror-filter-id ${aws_ec2_traffic_mirror_filter.web.id} --session-number 1 --tag-specifications 'ResourceType=traffic-mirror-session,Tags=[{Key=cloudlabs-lab,Value=${var.lab_id}}]'",
    "aws logs tail ${aws_cloudwatch_log_group.flow.name} --since 10m",
    "ssh labadmin@${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
