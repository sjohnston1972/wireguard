# ireland.tf
#
# Plain English: lab 29's Ireland side (eu-west-1, the session's secondary
# region). The second aws provider, alias secondary, exactly as spec §4
# writes it, and the lab's resource group there (groups are regional). A
# VPC, vpc-ireland (the slot's second /20), with two subnets in two zones,
# each with its own route table back to London's /20: snet-ireland-tgw
# through the Ireland transit gateway, snet-ireland-pcx through the VPC
# peering (ruling P18). A free S3 gateway endpoint on both, an Instance
# Connect Endpoint, eice-ireland, and the transit gateway tgw-ireland (ASN
# 64513: AWS recommends a different ASN on each side of a peering),
# attached in both subnets. The instances read Amazon Linux 2023 from
# Ireland's own copy of the public parameter (AMI ids are regional).

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "ireland" {
  provider = aws.secondary
  state    = "available"
}

data "aws_ssm_parameter" "al2023_ireland" {
  provider = aws.secondary
  name     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_resourcegroups_group" "secondary" {
  provider = aws.secondary
  name     = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}

resource "aws_vpc" "ireland" {
  provider             = aws.secondary
  cidr_block           = local.ireland_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-ireland" }
}

resource "aws_subnet" "ireland_tgw" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_tgw_subnet
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-tgw" }
}

resource "aws_subnet" "ireland_pcx" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_pcx_subnet
  availability_zone       = data.aws_availability_zones.ireland.names[1]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-pcx" }
}

resource "aws_route_table" "ireland_tgw" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-tgw" }
}

resource "aws_route_table" "ireland_pcx" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-pcx" }
}

resource "aws_route" "ireland_tgw_to_london" {
  provider               = aws.secondary
  route_table_id         = aws_route_table.ireland_tgw.id
  destination_cidr_block = local.vpc_cidr
  transit_gateway_id     = aws_ec2_transit_gateway.ireland.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.ireland]
}

resource "aws_route" "ireland_pcx_to_london" {
  provider                  = aws.secondary
  route_table_id            = aws_route_table.ireland_pcx.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  depends_on                = [aws_vpc_peering_connection_accepter.ireland]
}

resource "aws_route_table_association" "ireland_tgw" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_tgw.id
  route_table_id = aws_route_table.ireland_tgw.id
}

resource "aws_route_table_association" "ireland_pcx" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_pcx.id
  route_table_id = aws_route_table.ireland_pcx.id
}

resource "aws_vpc_endpoint" "ireland_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.ireland.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.ireland_tgw.id, aws_route_table.ireland_pcx.id]
  tags              = { Name = "vpce-s3-ireland" }
}

resource "aws_security_group" "eice_ireland" {
  provider    = aws.secondary
  name        = "lab-eice-ireland"
  description = "Instance Connect Endpoint in Ireland: SSH out to the Ireland instances"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-eice-ireland" }
}

resource "aws_vpc_security_group_egress_rule" "eice_ireland_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.eice_ireland.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "ireland" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.ireland_tgw.id
  security_group_ids = [aws_security_group.eice_ireland.id]
  preserve_client_ip = false
  tags               = { Name = "eice-ireland" }
}

resource "aws_ec2_transit_gateway" "ireland" {
  provider                        = aws.secondary
  description                     = "lab ${var.lab_id}: Ireland"
  amazon_side_asn                 = 64513
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-ireland" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "ireland" {
  provider           = aws.secondary
  transit_gateway_id = aws_ec2_transit_gateway.ireland.id
  vpc_id             = aws_vpc.ireland.id
  subnet_ids         = [aws_subnet.ireland_tgw.id, aws_subnet.ireland_pcx.id]
  tags               = { Name = "tgwa-ireland" }
}
