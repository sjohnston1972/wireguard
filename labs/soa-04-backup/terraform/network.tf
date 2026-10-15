# network.tf
#
# Plain English: the network most AWS labs start from (AWS labs spec §4).
# One VPC, the slot's first /20, with two private /24 subnets in two
# Availability Zones; a free S3 gateway endpoint so Amazon Linux 2023 installs
# packages with no NAT gateway (ruling A11); an EC2 Instance Connect Endpoint
# for console SSH with no public IP; and the instances' security group:
# SSH from the endpoint, and anything from the VPN server's VPC, which only
# reaches the lab once it is peered (the pipeline adds the peering and the
# route back). Also the AMI and the cloud-init every instance starts from.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  vpc_cidr = cidrsubnet(var.address_space, 2, 0)
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)

  # The labadmin user with the session's password (ruling A12), password SSH on. A lab adds its own
  # keys: user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, { runcmd = [...] }))}".
  cloud_init_base = {
    ssh_pwauth = true
    users = [
      "default",
      { name = "labadmin", groups = ["wheel"], sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", lock_passwd = false },
    ]
    chpasswd = { expire = false, list = "labadmin:${var.admin_password}\n" }
  }
  cloud_init = "#cloud-config\n${yamlencode(local.cloud_init_base)}"
}

resource "aws_vpc" "lab" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-lab" }
}

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.lab.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "vpce-s3" }
}

resource "aws_security_group" "eice" {
  name        = "lab-eice"
  description = "EC2 Instance Connect Endpoint: SSH out to the lab instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-eice" }
}

resource "aws_vpc_security_group_egress_rule" "eice_ssh" {
  security_group_id = aws_security_group.eice.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "lab" {
  subnet_id          = aws_subnet.private[0].id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-lab" }
}

resource "aws_security_group" "vms" {
  name        = "lab-vms"
  description = "Lab instances: SSH from the Instance Connect Endpoint, anything from the gateway when peered"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-vms" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_ssh_eice" {
  security_group_id            = aws_security_group.vms.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# Always present (ruling A45): Peer can come after deploy without a new apply.
resource "aws_vpc_security_group_ingress_rule" "vms_from_gateway" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "vms_all" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
