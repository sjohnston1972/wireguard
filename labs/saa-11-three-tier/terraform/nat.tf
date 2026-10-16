# nat.tf
#
# Plain English: lab 11's way out for the private subnets: a NAT gateway in
# snet-public-1 with an Elastic IP (public by nature, spec §7.4), and a
# default route to it in rt-private. The app tier installs its database and
# cache clients through it. While the lab is peered,
# the route the pipeline adds for the VPN server's range is more specific, so
# that traffic still goes through the peering.

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_internet]
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}
