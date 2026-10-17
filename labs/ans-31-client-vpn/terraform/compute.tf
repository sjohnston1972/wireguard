# compute.tf
#
# Plain English: lab 31's target, vm-target (t4g.nano, Amazon Linux 2023,
# snet-private-1), serving a page naming itself (lab-web.service, python3 on
# port 80). It admits SSH, HTTP and ping from the Client VPN endpoint's
# security group (Client VPN hands your traffic on from its own addresses in
# snet-private-1), SSH from the Instance Connect Endpoint and, once peered,
# SSH and HTTP from the VPN server's VPC (ruling A45).

locals {
  target_unit = join("\n", [
    "[Unit]",
    "Description=Lab 31 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"vm-target in vpc-lab, reached over AWS Client VPN\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  target_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.target_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "target" {
  name        = "lab-target"
  description = "vm-target: SSH, HTTP and ping over Client VPN, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-target" }
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_http_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "target_ping_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "icmp"
  from_port                    = -1
  to_port                      = -1
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_eice" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_gateway" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_http_gateway" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "target_all" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "target" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.target.id]
  user_data              = local.target_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-target" })
  tags        = { Name = "vm-target" }
  depends_on  = [aws_vpc_endpoint.s3]
}
