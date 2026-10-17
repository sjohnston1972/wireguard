# peering.tf
#
# Plain English: lab 29's two inter-region paths between the same VPCs
# (rulings P3, P15, P18). London asks for both: a transit gateway peering
# attachment from tgw-london to tgw-ireland, and a VPC peering from vpc-lab
# to vpc-ireland. Ireland accepts both through the secondary provider (an
# inter-region request is never accepted automatically; ruling P3 lets the
# lab role accept a peering whose Ireland side carries no lab tag until the
# accepter tags it). A transit gateway peering never propagates routes, so
# each side's default route table gets a static route to the other side's
# /20 through the peering attachment, once it is accepted.

resource "aws_ec2_transit_gateway_peering_attachment" "london_ireland" {
  transit_gateway_id      = aws_ec2_transit_gateway.london.id
  peer_region             = var.secondary_region
  peer_transit_gateway_id = aws_ec2_transit_gateway.ireland.id
  tags                    = { Name = "tgwp-london-ireland" }
}

resource "aws_ec2_transit_gateway_peering_attachment_accepter" "ireland" {
  provider                      = aws.secondary
  transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment.london_ireland.id
  tags                          = { Name = "tgwp-london-ireland" }
}

resource "aws_ec2_transit_gateway_route" "london_to_ireland" {
  destination_cidr_block         = local.ireland_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.london_ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.london.association_default_route_table_id
  depends_on                     = [aws_ec2_transit_gateway_peering_attachment_accepter.ireland]
}

resource "aws_ec2_transit_gateway_route" "ireland_to_london" {
  provider                       = aws.secondary
  destination_cidr_block         = local.vpc_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment_accepter.ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.ireland.association_default_route_table_id
}

resource "aws_vpc_peering_connection" "london_ireland" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.ireland.id
  peer_region = var.secondary_region
  auto_accept = false
  tags        = { Name = "pcx-london-ireland" }
}

resource "aws_vpc_peering_connection_accepter" "ireland" {
  provider                  = aws.secondary
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  auto_accept               = true
  tags                      = { Name = "pcx-london-ireland" }
}
