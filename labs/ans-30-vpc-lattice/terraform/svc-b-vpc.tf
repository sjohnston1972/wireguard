# svc-b-vpc.tf
#
# Plain English: lab 30's second VPC, vpc-svc-b (the slot's second /20),
# where service B's instance runs. Two private subnets in two Availability
# Zones, a route table with no route to vpc-lab (VPC Lattice needs none), a
# free S3 gateway endpoint, and its own Instance Connect Endpoint for console
# SSH to vm-svc-b.

locals {
  svc_b_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "svc_b" {
  cidr_block           = local.svc_b_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-svc-b" }
}

resource "aws_subnet" "svc_b" {
  count                   = 2
  vpc_id                  = aws_vpc.svc_b.id
  cidr_block              = cidrsubnet(local.svc_b_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-svc-b-${count.index + 1}" }
}

resource "aws_route_table" "svc_b" {
  vpc_id = aws_vpc.svc_b.id
  tags   = { Name = "rt-svc-b" }
}

resource "aws_route_table_association" "svc_b" {
  count          = 2
  subnet_id      = aws_subnet.svc_b[count.index].id
  route_table_id = aws_route_table.svc_b.id
}

resource "aws_vpc_endpoint" "svc_b_s3" {
  vpc_id            = aws_vpc.svc_b.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.svc_b.id]
  tags              = { Name = "vpce-s3-svc-b" }
}

resource "aws_security_group" "eice_svc_b" {
  name        = "lab-eice-svc-b"
  description = "Instance Connect Endpoint in vpc-svc-b: SSH out to vm-svc-b"
  vpc_id      = aws_vpc.svc_b.id
  tags        = { Name = "sg-eice-svc-b" }
}

resource "aws_vpc_security_group_egress_rule" "eice_svc_b_ssh" {
  security_group_id = aws_security_group.eice_svc_b.id
  cidr_ipv4         = local.svc_b_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "svc_b" {
  subnet_id          = aws_subnet.svc_b[0].id
  security_group_ids = [aws_security_group.eice_svc_b.id]
  preserve_client_ip = false
  tags               = { Name = "eice-svc-b" }
}
