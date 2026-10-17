# outputs.tf
#
# Plain English: what the dashboard shows once lab 23 is up: the two
# instances and the Resolver endpoints' addresses, how to connect to each
# instance, the three lookups the readme's Things to try start from, and,
# while peered, SSH and the page on vm-cloud. vpc-lab is the hub the
# pipeline peers to the VPN server's VPC.

output "private_ips" {
  value = {
    "vm-cloud"                      = aws_instance.cloud.private_ip
    "vm-dns"                        = aws_instance.dns.private_ip
    "Resolver inbound (rslvr-in)"   = join(", ", local.inbound_addresses)
    "Resolver outbound (rslvr-out)" = join(", ", sort([for a in aws_route53_resolver_endpoint.outbound.ip_address : a.ip]))
  }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.cloud.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.dns.id} --os-user labadmin --connection-type eice",
    "From vm-cloud: dig app.${local.corp_domain}",
    "From vm-dns: dig @${local.dns_ip} app.${local.cloud_domain}",
    "From vm-cloud: dig example.com (DNS Firewall answers NXDOMAIN)",
    "ssh labadmin@${aws_instance.cloud.private_ip}",
    "curl http://${aws_instance.cloud.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
