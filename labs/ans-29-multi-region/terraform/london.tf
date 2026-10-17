# london.tf
#
# Plain English: lab 29's London side. A transit gateway, tgw-london (ASN
# 64512, its default route table off, so everything is set by hand), attached
# to vpc-lab in both private subnets, with its own route table, tgw-rt-london:
# vpc-lab's attachment is associated with it and propagates into it (the
# peering attachment is associated in peering.tf). rt-private sends each Ireland subnet a different way (ruling
# P18): snet-ireland-tgw's /24 to the transit gateway, snet-ireland-pcx's
# /24 to the VPC peering. Those routes wait for the attachment and the
# accept respectively (peering.tf).

locals {
  ireland_cidr       = cidrsubnet(var.address_space, 2, 1)
  ireland_tgw_subnet = cidrsubnet(local.ireland_cidr, 4, 0)
  ireland_pcx_subnet = cidrsubnet(local.ireland_cidr, 4, 1)
}

resource "aws_ec2_transit_gateway" "london" {
  description                     = "lab ${var.lab_id}: London"
  amazon_side_asn                 = 64512
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-london" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "london" {
  transit_gateway_id                              = aws_ec2_transit_gateway.london.id
  vpc_id                                          = aws_vpc.lab.id
  subnet_ids                                      = aws_subnet.private[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-london" }
}

resource "aws_ec2_transit_gateway_route_table" "london" {
  transit_gateway_id = aws_ec2_transit_gateway.london.id
  tags               = { Name = "tgw-rt-london" }
}

resource "aws_ec2_transit_gateway_route_table_association" "london_vpc" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.london.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.london.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "london_vpc" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.london.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.london.id
}

resource "aws_route" "london_to_ireland_tgw" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = local.ireland_tgw_subnet
  transit_gateway_id     = aws_ec2_transit_gateway.london.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.london]
}

resource "aws_route" "london_to_ireland_pcx" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.ireland_pcx_subnet
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  depends_on                = [aws_vpc_peering_connection_accepter.ireland]
}
