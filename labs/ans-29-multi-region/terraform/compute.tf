# compute.tf
#
# Plain English: lab 29's three test instances (t4g.nano, Amazon Linux
# 2023), each serving a page naming itself: vm-london in snet-private-1, and
# in Ireland vm-ireland-tgw (reached from London through the transit
# gateways) and vm-ireland-pcx (reached through the VPC peering). The
# template's sg-vms gains ping and HTTP from Ireland's /20; Ireland's
# sg-vms-ireland admits ping and HTTP from London's /20 and SSH from
# eice-ireland. Security groups cannot name each other across regions, so
# these rules use ranges.

locals {
  web_unit = {
    path        = "/etc/systemd/system/lab-web.service"
    permissions = "0644"
    content     = join("\n", ["[Unit]", "Description=Lab page on port 80", "After=network-online.target", "[Service]", "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www", "Restart=always", "[Install]", "WantedBy=multi-user.target", ""])
  }
  web_runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
}

resource "aws_vpc_security_group_ingress_rule" "vms_icmp_ireland" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_http_ireland" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "vms_ireland" {
  provider    = aws.secondary
  name        = "lab-vms-ireland"
  description = "Ireland instances: ping and HTTP from London, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-vms-ireland" }
}

resource "aws_vpc_security_group_ingress_rule" "ireland_icmp_london" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "ireland_http_london" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "ireland_ssh_eice" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.vms_ireland.id
  referenced_security_group_id = aws_security_group.eice_ireland.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "ireland_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "london" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-london in vpc-lab (London)\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-london" })
  tags        = { Name = "vm-london" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "ireland_tgw" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_tgw.id
  vpc_security_group_ids = [aws_security_group.vms_ireland.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland-tgw in vpc-ireland, reached by the transit gateways\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland-tgw" })
  tags        = { Name = "vm-ireland-tgw" }
  depends_on  = [aws_vpc_endpoint.ireland_s3]
}

resource "aws_instance" "ireland_pcx" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_pcx.id
  vpc_security_group_ids = [aws_security_group.vms_ireland.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland-pcx in vpc-ireland, reached by the VPC peering\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland-pcx" })
  tags        = { Name = "vm-ireland-pcx" }
  depends_on  = [aws_vpc_endpoint.ireland_s3]
}
