# ireland.tf
#
# Plain English: lab 26's Ireland site (eu-west-1, the session's secondary
# region). The second aws provider, alias secondary, exactly as spec §4
# writes it, and the lab's resource group there (groups are regional). A VPC
# of its own, the slot's second /20, with a private subnet for vm-ireland
# (the same page, naming Ireland), a public subnet for its Network Load
# Balancer nlb-<name_prefix>-dub (no security group, ruling P9), an internet
# gateway, a free S3 gateway endpoint and an Instance Connect Endpoint. The
# instance reads the same public Amazon Linux 2023 parameter, in Ireland.

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

locals {
  ireland_vpc_cidr     = cidrsubnet(var.address_space, 2, 1)
  ireland_private_cidr = cidrsubnet(local.ireland_vpc_cidr, 4, 0)
  ireland_public_cidr  = cidrsubnet(local.ireland_vpc_cidr, 4, 1)
  ireland_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland in eu-west-1 (Ireland)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
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
  cidr_block           = local.ireland_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-ireland" }
}

resource "aws_subnet" "ireland_private" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_private_cidr
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-private" }
}

resource "aws_subnet" "ireland_public" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_public_cidr
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-public" }
}

resource "aws_internet_gateway" "ireland" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "igw-ireland" }
}

resource "aws_route_table" "ireland_private" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-private" }
}

resource "aws_route_table" "ireland_public" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-public" }
}

resource "aws_route" "ireland_public_internet" {
  provider               = aws.secondary
  route_table_id         = aws_route_table.ireland_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.ireland.id
}

resource "aws_route_table_association" "ireland_private" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_private.id
  route_table_id = aws_route_table.ireland_private.id
}

resource "aws_route_table_association" "ireland_public" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_public.id
  route_table_id = aws_route_table.ireland_public.id
}

resource "aws_vpc_endpoint" "ireland_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.ireland.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.ireland_private.id]
  tags              = { Name = "vpce-s3-ireland" }
}

resource "aws_security_group" "ireland_eice" {
  provider    = aws.secondary
  name        = "lab-eice-ireland"
  description = "EC2 Instance Connect Endpoint in Ireland: SSH out to vm-ireland"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-eice-ireland" }
}

resource "aws_vpc_security_group_egress_rule" "ireland_eice_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_eice.id
  cidr_ipv4         = local.ireland_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "ireland" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.ireland_private.id
  security_group_ids = [aws_security_group.ireland_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-ireland" }
}

resource "aws_security_group" "ireland_web" {
  provider    = aws.secondary
  name        = "lab-web-ireland"
  description = "vm-ireland: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-web-ireland" }
}

resource "aws_vpc_security_group_ingress_rule" "ireland_web_http" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "ireland_web_ssh" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.ireland_web.id
  referenced_security_group_id = aws_security_group.ireland_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "ireland_web_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "ireland" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_private.id
  vpc_security_group_ids = [aws_security_group.ireland_web.id]
  user_data              = local.ireland_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland" })
  tags        = { Name = "vm-ireland" }
  depends_on  = [aws_vpc_endpoint.ireland_s3, aws_route_table_association.ireland_private]
}

resource "aws_lb" "ireland" {
  provider                   = aws.secondary
  name                       = "nlb-${var.name_prefix}-dub"
  internal                   = false
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.ireland_public.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-dub" }

  depends_on = [aws_internet_gateway.ireland, aws_route_table_association.ireland_public, aws_route.ireland_public_internet]
}

resource "aws_lb_target_group" "ireland" {
  provider = aws.secondary
  name     = "tg-${var.name_prefix}-dub"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "tg-dub" }
}

resource "aws_lb_target_group_attachment" "ireland" {
  provider         = aws.secondary
  target_group_arn = aws_lb_target_group.ireland.arn
  target_id        = aws_instance.ireland.id
  port             = 80
}

resource "aws_lb_listener" "ireland" {
  provider          = aws.secondary
  load_balancer_arn = aws_lb.ireland.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ireland.arn
  }
  tags = { Name = "listener-dub" }
}
