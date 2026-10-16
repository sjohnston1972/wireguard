# ireland.tf
#
# Plain English: lab 16's pilot light in Ireland (eu-west-1, the session's
# secondary region; ruling P19). The second aws provider, alias secondary,
# exactly as spec §4 writes it, and the lab's resource group there (groups
# are regional). A VPC of its own, the slot's second /20, with one private
# subnet, a free S3 gateway endpoint, an Instance Connect Endpoint and a
# security group for the DR instance; and a launch template, lt-<prefix>-dr,
# from the AMI copied from London. Nothing runs here: launching the DR
# instance is a Thing to try, at a fixed address (local.dr_ip) the private
# zone already names.

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "dr" {
  provider = aws.secondary
  state    = "available"
}

locals {
  dr_vpc_cidr    = cidrsubnet(var.address_space, 2, 1)
  dr_subnet_cidr = cidrsubnet(local.dr_vpc_cidr, 4, 0)
  dr_ip          = cidrhost(local.dr_subnet_cidr, 10)
  dr_unit = join("\n", [
    "[Unit]",
    "Description=Lab 16 app page on port 80 (Ireland, DR)",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"app in Ireland (DR)\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dr_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.dr_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-app.service"]
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

resource "aws_vpc" "dr" {
  provider             = aws.secondary
  cidr_block           = local.dr_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-dr" }
}

resource "aws_subnet" "dr" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.dr.id
  cidr_block              = local.dr_subnet_cidr
  availability_zone       = data.aws_availability_zones.dr.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-dr" }
}

resource "aws_route_table" "dr" {
  provider = aws.secondary
  vpc_id   = aws_vpc.dr.id
  tags     = { Name = "rt-dr" }
}

resource "aws_route_table_association" "dr" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.dr.id
  route_table_id = aws_route_table.dr.id
}

resource "aws_vpc_endpoint" "dr_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.dr.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.dr.id]
  tags              = { Name = "vpce-s3-dr" }
}

resource "aws_security_group" "dr_eice" {
  provider    = aws.secondary
  name        = "lab-eice-dr"
  description = "EC2 Instance Connect Endpoint in Ireland: SSH out to the DR instance"
  vpc_id      = aws_vpc.dr.id
  tags        = { Name = "sg-eice-dr" }
}

resource "aws_vpc_security_group_egress_rule" "dr_eice_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr_eice.id
  cidr_ipv4         = local.dr_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "dr" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.dr.id
  security_group_ids = [aws_security_group.dr_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-dr" }
}

resource "aws_security_group" "dr" {
  provider    = aws.secondary
  name        = "lab-dr"
  description = "The DR instance: SSH from the Instance Connect Endpoint, HTTP inside its VPC"
  vpc_id      = aws_vpc.dr.id
  tags        = { Name = "sg-dr" }
}

resource "aws_vpc_security_group_ingress_rule" "dr_ssh_eice" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.dr.id
  referenced_security_group_id = aws_security_group.dr_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "dr_http" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr.id
  cidr_ipv4         = local.dr_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "dr_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_launch_template" "dr" {
  provider               = aws.secondary
  name                   = "lt-${var.name_prefix}-dr"
  image_id               = aws_ami_copy.dr.id
  instance_type          = "t4g.nano"
  user_data              = base64encode(local.dr_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tags = { Name = "lt-dr" }
}
