# outputs.tf
#
# Plain English: what the dashboard shows once lab 26 is up: the two
# instances' addresses, console SSH to each (Ireland's needs its region), and
# the three ways in: Global Accelerator's first static address, CloudFront's
# name, and each NLB directly. Lab 26 never peers (connectivity off), so it
# names no route tables for the VPN server's route.

output "private_ips" {
  value = { "vm-london" = aws_instance.london.private_ip, "vm-ireland" = aws_instance.ireland.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.london.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland.id} --os-user labadmin --connection-type eice",
    "Global Accelerator: curl http://${aws_globalaccelerator_accelerator.lab.ip_sets[0].ip_addresses[0]}/",
    "CloudFront: curl -I https://${aws_cloudfront_distribution.lab.domain_name}/",
    "NLBs directly: curl http://${aws_lb.london.dns_name}/ and curl http://${aws_lb.ireland.dns_name}/",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = []
}
