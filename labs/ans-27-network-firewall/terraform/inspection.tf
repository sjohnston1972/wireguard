# inspection.tf
#
# Plain English: lab 27's inspection VPC, vpc-inspection (the slot's third
# /20), all in the first zone: snet-insp-tgw holds the transit gateway's
# attachment, snet-insp-firewall the firewall's endpoint, snet-insp-public
# the NAT gateway (and the internet gateway beyond it). The route tables
# make one path through the firewall for everything. From the transit
# gateway, every packet goes to the firewall endpoint. From the firewall's
# subnet, the internet is through the NAT gateway and the spokes (the slot)
# are back through the transit gateway. From the NAT gateway's subnet,
# replies for the spokes go through the firewall endpoint again, so the
# firewall sees both directions of every flow. The endpoint's id is read
# from the firewall's own status, written out in each of the two routes.

locals {
  insp_cidr = cidrsubnet(var.address_space, 2, 2)
}

resource "aws_vpc" "inspection" {
  cidr_block           = local.insp_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-inspection" }
}

resource "aws_subnet" "insp_tgw" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 0)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-tgw" }
}

resource "aws_subnet" "insp_firewall" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 1)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-firewall" }
}

resource "aws_subnet" "insp_public" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-public" }
}

resource "aws_internet_gateway" "inspection" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "igw-inspection" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "inspection" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.insp_public.id
  tags          = { Name = "nat-inspection" }
  depends_on    = [aws_internet_gateway.inspection, aws_route.insp_public_default]
}

resource "aws_route_table" "insp_tgw" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-tgw" }
}

resource "aws_route_table" "insp_firewall" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-firewall" }
}

resource "aws_route_table" "insp_public" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-public" }
}

resource "aws_route" "insp_tgw_default" {
  route_table_id         = aws_route_table.insp_tgw.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = one([for s in aws_networkfirewall_firewall.lab.firewall_status[0].sync_states : s.attachment[0].endpoint_id])
}

resource "aws_route" "insp_firewall_default" {
  route_table_id         = aws_route_table.insp_firewall.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.inspection.id
}

resource "aws_route" "insp_firewall_slot" {
  route_table_id         = aws_route_table.insp_firewall.id
  destination_cidr_block = var.address_space
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.inspection]
}

resource "aws_route" "insp_public_default" {
  route_table_id         = aws_route_table.insp_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.inspection.id
}

resource "aws_route" "insp_public_slot" {
  route_table_id         = aws_route_table.insp_public.id
  destination_cidr_block = var.address_space
  vpc_endpoint_id        = one([for s in aws_networkfirewall_firewall.lab.firewall_status[0].sync_states : s.attachment[0].endpoint_id])
}

resource "aws_route_table_association" "insp_tgw" {
  subnet_id      = aws_subnet.insp_tgw.id
  route_table_id = aws_route_table.insp_tgw.id
}

resource "aws_route_table_association" "insp_firewall" {
  subnet_id      = aws_subnet.insp_firewall.id
  route_table_id = aws_route_table.insp_firewall.id
}

resource "aws_route_table_association" "insp_public" {
  subnet_id      = aws_subnet.insp_public.id
  route_table_id = aws_route_table.insp_public.id
}
