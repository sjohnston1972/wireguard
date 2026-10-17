# subnets.tf
#
# Plain English: lab 25's subnets, all in the template's vpc-lab (the slot's
# first /20). Two public subnets (the slot's /24s 2 and 3, one per zone) for
# the ALB, the NLB and the NAT gateway; and, in the first zone, a subnet for
# the appliance behind the Gateway Load Balancer (/24 4), one for the GWLB
# endpoint (/24 5) and one for the client whose internet traffic it inspects
# (/24 6). The routes make the inspection path: the client's default route is
# the GWLB endpoint; what the appliance sends back leaves through the NAT
# gateway; and the public route table sends replies for the client's /24 back
# through the endpoint, so both directions pass the appliance. The appliance
# reaches the internet (to build its software) through the NAT gateway.

locals {
  public_cidrs   = [cidrsubnet(local.vpc_cidr, 4, 2), cidrsubnet(local.vpc_cidr, 4, 3)]
  appliance_cidr = cidrsubnet(local.vpc_cidr, 4, 4)
  gwlbe_cidr     = cidrsubnet(local.vpc_cidr, 4, 5)
  inspected_cidr = cidrsubnet(local.vpc_cidr, 4, 6)
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-public-${count.index + 1}" }
}

resource "aws_subnet" "appliance" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.appliance_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-appliance" }
}

resource "aws_subnet" "gwlbe" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.gwlbe_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-gwlbe" }
}

resource "aws_subnet" "inspected" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.inspected_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-inspected" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

# The NLB's static address (ruling P14): a subnet mapping, never on an instance.
resource "aws_eip" "nlb" {
  domain = "vpc"
  tags   = { Name = "eip-nlb" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_internet]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route_table" "appliance" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-appliance" }
}

resource "aws_route_table" "gwlbe" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-gwlbe" }
}

resource "aws_route_table" "inspected" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-inspected" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

# Replies from the internet to the client come back through the appliance (more specific than the VPC's local route).
resource "aws_route" "public_inspected" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = local.inspected_cidr
  vpc_endpoint_id        = aws_vpc_endpoint.gwlb.id
}

resource "aws_route" "appliance_nat" {
  route_table_id         = aws_route_table.appliance.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "gwlbe_nat" {
  route_table_id         = aws_route_table.gwlbe.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "inspected_gwlbe" {
  route_table_id         = aws_route_table.inspected.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = aws_vpc_endpoint.gwlb.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "appliance" {
  subnet_id      = aws_subnet.appliance.id
  route_table_id = aws_route_table.appliance.id
}

resource "aws_route_table_association" "gwlbe" {
  subnet_id      = aws_subnet.gwlbe.id
  route_table_id = aws_route_table.gwlbe.id
}

resource "aws_route_table_association" "inspected" {
  subnet_id      = aws_subnet.inspected.id
  route_table_id = aws_route_table.inspected.id
}
