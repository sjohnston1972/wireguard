# outputs.tf
#
# Plain English: what the dashboard shows once lab 31 is up: vm-target's
# address, how to reach it (the Instance Connect Endpoint, over Client VPN,
# and, while peered, over WireGuard), and the files (ruling P2): an OpenVPN
# profile, ans-31.ovpn, holding the endpoint's name, the CA, your client
# certificate and its key inline, plus the certificate and key on their own.
# The files output is sensitive: Terraform never prints it, the pipeline
# sends it beside the run's result, and the dashboard hands it out only under
# Show while the session runs (ruling A13). remote-random-hostname puts a
# random label in front of the endpoint's name, as AWS's own profiles do.

locals {
  ovpn = join("\n", [
    "client",
    "dev tun",
    "proto udp",
    "remote ${replace(aws_ec2_client_vpn_endpoint.lab.dns_name, "*.", "")} 443",
    "remote-random-hostname",
    "resolv-retry infinite",
    "nobind",
    "remote-cert-tls server",
    "cipher AES-256-GCM",
    "verb 3",
    "reneg-sec 0",
    "<ca>",
    trimspace(tls_self_signed_cert.ca.cert_pem),
    "</ca>",
    "<cert>",
    trimspace(tls_locally_signed_cert.client.cert_pem),
    "</cert>",
    "<key>",
    trimspace(tls_private_key.client.private_key_pem),
    "</key>",
    "",
  ])
}

output "private_ips" {
  value = { "vm-target" = aws_instance.target.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.target.id} --os-user labadmin --connection-type eice",
    "Download ans-31.ovpn under Show, import it into the AWS VPN Client or OpenVPN, then: ssh labadmin@${aws_instance.target.private_ip}, curl http://${aws_instance.target.private_ip}",
    "ssh labadmin@${aws_instance.target.private_ip}",
    "curl http://${aws_instance.target.private_ip}",
  ]
}

output "files" {
  sensitive = true
  value = {
    "ans-31.ovpn" = local.ovpn
    "client.crt"  = tls_locally_signed_cert.client.cert_pem
    "client.key"  = tls_private_key.client.private_key_pem
  }
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
