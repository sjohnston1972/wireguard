# tgw.tf
#
# Plain English: lab 21's transit gateway, tgw-lab, and how it segments the
# three VPCs (ruling P15). Its default route table is off, so every
# attachment is associated and propagated by hand: spoke A (vpc-lab), spoke
# B and the egress VPC each attach in two zones, the egress attachment in
# appliance mode (a flow and its reply keep to one zone). The spokes use
# tgw-rt-spokes: everything to the egress VPC, and spoke B's range a
# blackhole, so spoke A can never reach spoke B. The egress attachment uses
# tgw-rt-egress, which both spokes propagate into, so replies from the
# internet find their way back. Each spoke's default route points at the
# transit gateway, and the egress VPC's public route table sends the slot
# back to it. Nothing is shared with another account
# (auto_accept_shared_attachments off).

resource "aws_ec2_transit_gateway" "lab" {
  description                     = "lab ${var.lab_id}: two spokes and central egress"
  amazon_side_asn                 = 64512
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
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

resource "aws_ec2_transit_gateway_vpc_attachment" "egress" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.egress.id
  subnet_ids                                      = aws_subnet.egress_tgw[*].id
  appliance_mode_support                          = "enable"
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-egress" }
}

resource "aws_ec2_transit_gateway_route_table" "spokes" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-spokes" }
}

resource "aws_ec2_transit_gateway_route_table" "egress" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-egress" }
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "egress" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.egress.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route" "spokes_default" {
  destination_cidr_block         = "0.0.0.0/0"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.egress.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route" "spokes_blackhole_b" {
  destination_cidr_block         = local.spoke_b_cidr
  blackhole                      = true
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

# A VPC route to a transit gateway needs that VPC's attachment first.
resource "aws_route" "spoke_a_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_a]
}

resource "aws_route" "spoke_b_default" {
  route_table_id         = aws_route_table.spoke_b.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_b]
}

resource "aws_route" "egress_public_slot" {
  route_table_id         = aws_route_table.egress_public.id
  destination_cidr_block = var.address_space
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.egress]
}
