# spoke-b.tf
#
# Plain English: lab 21's second spoke, vpc-spoke-b (the slot's second
# /20), two private subnets in two zones, its own route table rt-spoke-b
# (its default route to the transit gateway is in tgw.tf), a free S3 gateway
# endpoint and its own Instance Connect Endpoint, eice-spoke-b, so vm-b is
# reachable from the console though no route leads to it from vpc-lab.

locals {
  spoke_b_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "spoke_b" {
  cidr_block           = local.spoke_b_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-spoke-b" }
}

resource "aws_subnet" "spoke_b" {
  count                   = 2
  vpc_id                  = aws_vpc.spoke_b.id
  cidr_block              = cidrsubnet(local.spoke_b_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-spoke-b-${count.index + 1}" }
}

resource "aws_route_table" "spoke_b" {
  vpc_id = aws_vpc.spoke_b.id
  tags   = { Name = "rt-spoke-b" }
}

resource "aws_route_table_association" "spoke_b" {
  count          = 2
  subnet_id      = aws_subnet.spoke_b[count.index].id
  route_table_id = aws_route_table.spoke_b.id
}

resource "aws_vpc_endpoint" "spoke_b_s3" {
  vpc_id            = aws_vpc.spoke_b.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.spoke_b.id]
  tags              = { Name = "vpce-s3-spoke-b" }
}

resource "aws_security_group" "eice_spoke_b" {
  name        = "lab-eice-spoke-b"
  description = "Instance Connect Endpoint in vpc-spoke-b: SSH out to vm-b"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-eice-spoke-b" }
}

resource "aws_vpc_security_group_egress_rule" "eice_spoke_b_ssh" {
  security_group_id = aws_security_group.eice_spoke_b.id
  cidr_ipv4         = local.spoke_b_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "spoke_b" {
  subnet_id          = aws_subnet.spoke_b[0].id
  security_group_ids = [aws_security_group.eice_spoke_b.id]
  preserve_client_ip = false
  tags               = { Name = "eice-spoke-b" }
}
