# tgw.tf
#
# Plain English: lab 27's transit gateway, tgw-lab, with its default route
# tables switched off so every association is written here (ruling P15). The
# two spokes are associated with tgw-rt-spokes, whose only route sends
# everything (0.0.0.0/0) to the inspection VPC's attachment. The inspection
# attachment is associated with tgw-rt-inspection, which learns both spokes'
# ranges by propagation, so traffic the firewall passes finds its way back.
# Appliance mode on the inspection attachment keeps both directions of a
# flow in the same zone, so the firewall sees the whole conversation. Each
# spoke's own default route points at the transit gateway; the VPN server's
# more specific route, added when peered, still wins for its range.

resource "aws_ec2_transit_gateway" "lab" {
  description                     = "lab ${var.lab_id}: spokes through the inspection VPC"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
  auto_accept_shared_attachments  = "disable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-lab" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_a" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.lab.id
  subnet_ids                                      = aws_subnet.private[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-a" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_b" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.spoke_b.id
  subnet_ids                                      = aws_subnet.spoke_b[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-b" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "inspection" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.inspection.id
  subnet_ids                                      = [aws_subnet.insp_tgw.id]
  appliance_mode_support                          = "enable"
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-inspection" }
}

resource "aws_ec2_transit_gateway_route_table" "spokes" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-spokes" }
}

resource "aws_ec2_transit_gateway_route_table" "inspection" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-inspection" }
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "inspection" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.inspection.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route" "spokes_default" {
  destination_cidr_block         = "0.0.0.0/0"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.inspection.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_route" "private_tgw" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_a]
}

resource "aws_route" "spoke_b_tgw" {
  route_table_id         = aws_route_table.spoke_b.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_b]
}
