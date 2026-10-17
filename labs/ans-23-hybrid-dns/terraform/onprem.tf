# onprem.tf
#
# Plain English: lab 23's pretend data centre, vpc-onprem (the slot's second
# /20), peered to the cloud VPC (the template's vpc-lab) by the lab itself,
# with a route each way. Its one subnet, snet-onprem-1, holds the "on-prem"
# DNS server vm-dns at a fixed address (local.dns_ip) and the VPC's own
# Instance Connect Endpoint; a free S3 gateway endpoint lets vm-dns install
# dnsmasq with no NAT gateway (ruling A11). The endpoint is made after vm-dns,
# so it can never take the fixed address first.

locals {
  onprem_cidr        = cidrsubnet(var.address_space, 2, 1)
  onprem_subnet_cidr = cidrsubnet(local.onprem_cidr, 4, 0)
  dns_ip             = cidrhost(local.onprem_subnet_cidr, 10)
}

resource "aws_vpc" "onprem" {
  cidr_block           = local.onprem_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-onprem" }
}

resource "aws_subnet" "onprem" {
  vpc_id                  = aws_vpc.onprem.id
  cidr_block              = local.onprem_subnet_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-onprem-1" }
}

resource "aws_route_table" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "rt-onprem" }
}

resource "aws_route_table_association" "onprem" {
  subnet_id      = aws_subnet.onprem.id
  route_table_id = aws_route_table.onprem.id
}

resource "aws_vpc_endpoint" "onprem_s3" {
  vpc_id            = aws_vpc.onprem.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.onprem.id]
  tags              = { Name = "vpce-s3-onprem" }
}

resource "aws_vpc_peering_connection" "cloud_onprem" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.onprem.id
  auto_accept = true
  tags        = { Name = "pcx-cloud-onprem" }
}

resource "aws_route" "cloud_to_onprem" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.onprem_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.cloud_onprem.id
}

resource "aws_route" "onprem_to_cloud" {
  route_table_id            = aws_route_table.onprem.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.cloud_onprem.id
}

resource "aws_security_group" "eice_onprem" {
  name        = "lab-eice-onprem"
  description = "Instance Connect Endpoint in vpc-onprem: SSH out to vm-dns"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-eice-onprem" }
}

resource "aws_vpc_security_group_egress_rule" "eice_onprem_ssh" {
  security_group_id = aws_security_group.eice_onprem.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "onprem" {
  subnet_id          = aws_subnet.onprem.id
  security_group_ids = [aws_security_group.eice_onprem.id]
  preserve_client_ip = false
  tags               = { Name = "eice-onprem" }
  depends_on         = [aws_instance.dns]
}
