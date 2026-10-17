# egress.tf
#
# Plain English: lab 21's central way out, vpc-egress (the slot's third
# /20). The transit gateway's interfaces sit in snet-egress-tgw-1/2, whose
# route table rt-egress-tgw sends everything to the NAT gateway nat-egress;
# the NAT gateway sits in snet-egress-public, whose route table
# rt-egress-public sends the internet to igw-egress and the whole slot back
# to the transit gateway (that route is in tgw.tf), so replies find their
# spoke. No instance runs here: the spokes share this one NAT gateway.

locals {
  egress_cidr = cidrsubnet(var.address_space, 2, 2)
}

resource "aws_vpc" "egress" {
  cidr_block           = local.egress_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-egress" }
}

resource "aws_subnet" "egress_tgw" {
  count                   = 2
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(local.egress_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-egress-tgw-${count.index + 1}" }
}

resource "aws_subnet" "egress_public" {
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(local.egress_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-egress-public" }
}

resource "aws_internet_gateway" "egress" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "igw-egress" }
}

resource "aws_route_table" "egress_public" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "rt-egress-public" }
}

resource "aws_route" "egress_public_internet" {
  route_table_id         = aws_route_table.egress_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.egress.id
}

resource "aws_route_table_association" "egress_public" {
  subnet_id      = aws_subnet.egress_public.id
  route_table_id = aws_route_table.egress_public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "egress" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.egress_public.id
  tags          = { Name = "nat-egress" }
  depends_on    = [aws_internet_gateway.egress, aws_route.egress_public_internet]
}

resource "aws_route_table" "egress_tgw" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "rt-egress-tgw" }
}

resource "aws_route" "egress_tgw_nat" {
  route_table_id         = aws_route_table.egress_tgw.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.egress.id
}

resource "aws_route_table_association" "egress_tgw" {
  count          = 2
  subnet_id      = aws_subnet.egress_tgw[count.index].id
  route_table_id = aws_route_table.egress_tgw.id
}
