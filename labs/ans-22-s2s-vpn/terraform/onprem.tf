# onprem.tf
#
# Plain English: lab 22's pretend data centre, vpc-onprem (the slot's second
# /20). One subnet, snet-onprem, holds the router vm-router (router.tf) and
# the VPC's own Instance Connect Endpoint, eice-onprem. Its route table,
# rt-onprem, sends the internet to igw-onprem (the router's Elastic IP is
# how AWS's VPN endpoints reach it) and vpc-lab's range to the router
# itself, as an office's LAN would send it to its VPN box. No route joins
# the two VPCs: the only way between them is the VPN.

locals {
  onprem_cidr        = cidrsubnet(var.address_space, 2, 1)
  onprem_subnet_cidr = cidrsubnet(local.onprem_cidr, 4, 0)
  router_ip          = cidrhost(local.onprem_subnet_cidr, 10)
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
  tags                    = { Name = "snet-onprem" }
}

resource "aws_internet_gateway" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "igw-onprem" }
}

resource "aws_route_table" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "rt-onprem" }
}

resource "aws_route" "onprem_internet" {
  route_table_id         = aws_route_table.onprem.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.onprem.id
}

resource "aws_route" "onprem_to_aws" {
  route_table_id         = aws_route_table.onprem.id
  destination_cidr_block = local.vpc_cidr
  network_interface_id   = aws_instance.router.primary_network_interface_id
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

resource "aws_security_group" "eice_onprem" {
  name        = "lab-eice-onprem"
  description = "Instance Connect Endpoint in vpc-onprem: SSH out to vm-router"
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
  # After the router, so AWS cannot hand the endpoint the router's fixed address.
  depends_on = [aws_instance.router]
}
