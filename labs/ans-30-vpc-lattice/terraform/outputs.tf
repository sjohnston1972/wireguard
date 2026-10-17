# outputs.tf
#
# Plain English: what the dashboard shows once lab 30 is up: the three
# instances, how to connect to vm-client and vm-svc-b, the two services'
# Lattice names (each answers only signed, allowed requests: lattice-curl on
# vm-client signs them), and, while peered, SSH and the page on vm-client.
# vpc-lab is the hub.

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip, "vm-svc-a" = aws_instance.svc_a.private_ip, "vm-svc-b" = aws_instance.svc_b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.svc_b.id} --os-user labadmin --connection-type eice",
    "svc-a: http://${aws_vpclattice_service.a.dns_entry[0].domain_name}  (from vm-client: lattice-curl http://${aws_vpclattice_service.a.dns_entry[0].domain_name})",
    "svc-b: http://${aws_vpclattice_service.b.dns_entry[0].domain_name}  (from vm-client: lattice-curl http://${aws_vpclattice_service.b.dns_entry[0].domain_name})",
    "ssh labadmin@${aws_instance.client.private_ip}",
    "curl http://${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
