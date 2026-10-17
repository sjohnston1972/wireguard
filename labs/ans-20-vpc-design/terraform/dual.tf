# dual.tf
#
# Plain English: lab 20's dual-stack half of vpc-lab. A secondary IPv4 range
# (the slot's second /20, added to the VPC without IPAM) holds three subnets,
# each with a /64 of the VPC's IPv6 /56: snet-dual-1 and snet-dual-2 for
# instances, and snet-public for the NAT gateway. The ways out differ by
# family: rt-public sends both families to the internet gateway igw-lab;
# rt-dual sends IPv4 to the NAT gateway nat-lab (ruling A11: vm-dual reaches
# packages that way; vpce-s3 stays on rt-private) and IPv6 to the
# egress-only gateway eigw-lab, which lets replies in but never a new
# connection. And the managed prefix list pl-admin (the VPN server's VPC and
# vpc-lab's primary range; ruling P6: IPv4 inside the slot or the gateway's
# range only), which compute.tf's security group names instead of addresses.
# The template's Instance Connect Endpoint gains SSH to the secondary range.

locals {
  secondary_cidr = cidrsubnet(var.address_space, 2, 1)
  vpc_ipv6_cidr  = aws_vpc_ipv6_cidr_block_association.lab.ipv6_cidr_block
}

resource "aws_vpc_ipv4_cidr_block_association" "secondary" {
  vpc_id     = aws_vpc.lab.id
  cidr_block = local.secondary_cidr
}

resource "aws_subnet" "dual" {
  count                           = 2
  vpc_id                          = aws_vpc.lab.id
  cidr_block                      = cidrsubnet(local.secondary_cidr, 4, count.index)
  ipv6_cidr_block                 = cidrsubnet(local.vpc_ipv6_cidr, 8, count.index)
  assign_ipv6_address_on_creation = true
  availability_zone               = local.azs[count.index]
  map_public_ip_on_launch         = false
  tags                            = { Name = "snet-dual-${count.index + 1}" }
  depends_on                      = [aws_vpc_ipv4_cidr_block_association.secondary]
}

resource "aws_subnet" "public" {
  vpc_id                          = aws_vpc.lab.id
  cidr_block                      = cidrsubnet(local.secondary_cidr, 4, 2)
  ipv6_cidr_block                 = cidrsubnet(local.vpc_ipv6_cidr, 8, 2)
  assign_ipv6_address_on_creation = true
  availability_zone               = local.azs[0]
  map_public_ip_on_launch         = false
  tags                            = { Name = "snet-public" }
  depends_on                      = [aws_vpc_ipv4_cidr_block_association.secondary]
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_egress_only_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "eigw-lab" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route" "public_v4" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route" "public_v6" {
  route_table_id              = aws_route_table.public.id
  destination_ipv6_cidr_block = "::/0"
  gateway_id                  = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_v4]
}

resource "aws_route_table" "dual" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-dual" }
}

resource "aws_route" "dual_v4" {
  route_table_id         = aws_route_table.dual.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "dual_v6" {
  route_table_id              = aws_route_table.dual.id
  destination_ipv6_cidr_block = "::/0"
  egress_only_gateway_id      = aws_egress_only_internet_gateway.lab.id
}

resource "aws_route_table_association" "dual" {
  count          = 2
  subnet_id      = aws_subnet.dual[count.index].id
  route_table_id = aws_route_table.dual.id
}

resource "aws_ec2_managed_prefix_list" "admin" {
  name           = "lab-${var.lab_id}-admin"
  address_family = "IPv4"
  max_entries    = 4

  entry {
    cidr        = var.gateway_cidr
    description = "the WireGuard server VPC"
  }
  entry {
    cidr        = local.vpc_cidr
    description = "vpc-lab primary"
  }
  tags = { Name = "pl-admin" }
}

# The template's endpoint sits in snet-private-1 (the primary range); it reaches vm-dual in the secondary one.
resource "aws_vpc_security_group_egress_rule" "eice_ssh_secondary" {
  security_group_id = aws_security_group.eice.id
  cidr_ipv4         = local.secondary_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}
