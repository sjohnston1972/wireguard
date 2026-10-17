# service.tf
#
# Plain English: lab 28's service VPC, vpc-service (the slot's second /20),
# peered to the client VPC (the template's vpc-lab) with a route on each
# side. Two subnets in the first zone: snet-nlb (the load balancer and the
# monitor instance) and snet-svc (the web instance, vm-svc). The service
# VPC's own Instance Connect Endpoint sits in snet-svc, beside vm-svc, so the
# subnet's network ACL never stands between them (ACLs filter only traffic
# entering or leaving a subnet; A75). A free S3 gateway endpoint serves
# packages.

locals {
  svc_vpc_cidr = cidrsubnet(var.address_space, 2, 1)
  nlb_cidr     = cidrsubnet(local.svc_vpc_cidr, 4, 0)
  svc_cidr     = cidrsubnet(local.svc_vpc_cidr, 4, 1)
}

resource "aws_vpc" "service" {
  cidr_block           = local.svc_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-service" }
}

resource "aws_subnet" "nlb" {
  vpc_id                  = aws_vpc.service.id
  cidr_block              = local.nlb_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-nlb" }
}

resource "aws_subnet" "svc" {
  vpc_id                  = aws_vpc.service.id
  cidr_block              = local.svc_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-svc" }
}

resource "aws_route_table" "service" {
  vpc_id = aws_vpc.service.id
  tags   = { Name = "rt-service" }
}

resource "aws_route_table_association" "nlb" {
  subnet_id      = aws_subnet.nlb.id
  route_table_id = aws_route_table.service.id
}

resource "aws_route_table_association" "svc" {
  subnet_id      = aws_subnet.svc.id
  route_table_id = aws_route_table.service.id
}

resource "aws_vpc_endpoint" "service_s3" {
  vpc_id            = aws_vpc.service.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.service.id]
  tags              = { Name = "vpce-s3-service" }
}

resource "aws_vpc_peering_connection" "client_service" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.service.id
  auto_accept = true
  tags        = { Name = "pcx-client-service" }
}

resource "aws_route" "client_to_service" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.svc_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.client_service.id
}

resource "aws_route" "service_to_client" {
  route_table_id            = aws_route_table.service.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.client_service.id
}

resource "aws_security_group" "service_eice" {
  name        = "lab-eice-service"
  description = "Instance Connect Endpoint in vpc-service: SSH out to vm-svc and vm-monitor"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-eice-service" }
}

resource "aws_vpc_security_group_egress_rule" "service_eice_ssh" {
  security_group_id = aws_security_group.service_eice.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "service" {
  subnet_id          = aws_subnet.svc.id
  security_group_ids = [aws_security_group.service_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-service" }
}
