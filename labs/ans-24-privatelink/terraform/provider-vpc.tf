# provider-vpc.tf
#
# Plain English: lab 24's provider side, vpc-provider (the slot's second
# /20), the VPC of a team that publishes a service. Two private subnets in
# two Availability Zones for its load balancer, a route table with no route
# to the consumer at all (PrivateLink needs none), a free S3 gateway
# endpoint, and its own Instance Connect Endpoint for console SSH to
# vm-provider.

locals {
  provider_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "provider" {
  cidr_block           = local.provider_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-provider" }
}

resource "aws_subnet" "provider" {
  count                   = 2
  vpc_id                  = aws_vpc.provider.id
  cidr_block              = cidrsubnet(local.provider_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-provider-${count.index + 1}" }
}

resource "aws_route_table" "provider" {
  vpc_id = aws_vpc.provider.id
  tags   = { Name = "rt-provider" }
}

resource "aws_route_table_association" "provider" {
  count          = 2
  subnet_id      = aws_subnet.provider[count.index].id
  route_table_id = aws_route_table.provider.id
}

resource "aws_vpc_endpoint" "provider_s3" {
  vpc_id            = aws_vpc.provider.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.provider.id]
  tags              = { Name = "vpce-s3-provider" }
}

resource "aws_security_group" "eice_provider" {
  name        = "lab-eice-provider"
  description = "Instance Connect Endpoint in vpc-provider: SSH out to vm-provider"
  vpc_id      = aws_vpc.provider.id
  tags        = { Name = "sg-eice-provider" }
}

resource "aws_vpc_security_group_egress_rule" "eice_provider_ssh" {
  security_group_id = aws_security_group.eice_provider.id
  cidr_ipv4         = local.provider_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "provider" {
  subnet_id          = aws_subnet.provider[0].id
  security_group_ids = [aws_security_group.eice_provider.id]
  preserve_client_ip = false
  tags               = { Name = "eice-provider" }
}
