# cvpn.tf
#
# Plain English: lab 31's Client VPN endpoint, cvpn-lab (ruling P20).
# Clients prove who they are with a certificate from the lab's CA (mutual
# authentication; directory and SAML sign-in are never built). They get an
# address from the client range, the last /22 of the slot (inside the slot,
# outside every lab VPC), over OpenVPN on UDP 443. Split tunnel: only the
# lab VPC's range goes through the VPN, everything else stays on your own
# connection. One target network association, snet-private-1 (each bills
# by the hour; associating also adds the route to the VPC's range), and one
# authorisation rule letting every connected client reach vpc-lab.
# Connection logging and the self-service portal are off (ruling P8: no log
# group outside the lab's naming). The endpoint's security group sg-cvpn
# lets the VPN's traffic out to vpc-lab only.

locals {
  client_cidr = cidrsubnet(var.address_space, 4, 15)
}

resource "aws_security_group" "cvpn" {
  name        = "lab-cvpn"
  description = "Client VPN endpoint: out to vpc-lab only"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cvpn" }
}

resource "aws_vpc_security_group_egress_rule" "cvpn_to_lab" {
  security_group_id = aws_security_group.cvpn.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "-1"
}

resource "aws_ec2_client_vpn_endpoint" "lab" {
  description            = "lab-${var.lab_id}"
  server_certificate_arn = aws_acm_certificate.server.arn
  client_cidr_block      = local.client_cidr
  split_tunnel           = true
  transport_protocol     = "udp"
  vpn_port               = 443
  vpc_id                 = aws_vpc.lab.id
  security_group_ids     = [aws_security_group.cvpn.id]
  self_service_portal    = "disabled"
  session_timeout_hours  = 8

  authentication_options {
    type                       = "certificate-authentication"
    root_certificate_chain_arn = aws_acm_certificate.server.arn
  }
  connection_log_options {
    enabled = false
  }
  tags = { Name = "cvpn-lab" }
}

resource "aws_ec2_client_vpn_network_association" "lab" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.lab.id
  subnet_id              = aws_subnet.private[0].id
}

resource "aws_ec2_client_vpn_authorization_rule" "lab" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.lab.id
  target_network_cidr    = local.vpc_cidr
  authorize_all_groups   = true
  description            = "every connected client may reach vpc-lab"
}
