# compute.tf
#
# Plain English: lab 24's two instances (t4g.nano, Amazon Linux 2023), each
# serving a page naming itself (lab-web.service, python3 on port 80).
# vm-consumer in vpc-lab runs as the consumer role; vm-provider in
# vpc-provider is the endpoint service's only target and admits HTTP from
# its own VPC, where the load balancer's addresses are. Each admits SSH from
# its VPC's Instance Connect Endpoint and, once peered, SSH and HTTP from the
# VPN server's VPC (ruling A45).

locals {
  pages = {
    consumer = "vm-consumer in vpc-lab, the consumer"
    provider = "vm-provider in vpc-provider, reached through PrivateLink"
  }
  web_units = { for k, text in local.pages : k => join("\n", [
    "[Unit]",
    "Description=Lab 24 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"${text}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ]) }
  web_cloud_init = { for k, unit in local.web_units : k => "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}" }
}

resource "aws_security_group" "consumer" {
  name        = "lab-consumer"
  description = "vm-consumer: SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-consumer" }
}

resource "aws_vpc_security_group_ingress_rule" "consumer_ssh_eice" {
  security_group_id            = aws_security_group.consumer.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "consumer_ssh_gateway" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "consumer_http_gateway" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "consumer_all" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "provider" {
  name        = "lab-provider"
  description = "vm-provider: HTTP from vpc-provider (the load balancer), SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.provider.id
  tags        = { Name = "sg-provider" }
}

resource "aws_vpc_security_group_ingress_rule" "provider_http" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = local.provider_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "provider_ssh_eice" {
  security_group_id            = aws_security_group.provider.id
  referenced_security_group_id = aws_security_group.eice_provider.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "provider_ssh_gateway" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "provider_http_gateway" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "provider_all" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "consumer" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.consumer.id]
  iam_instance_profile   = aws_iam_instance_profile.consumer.name
  user_data              = local.web_cloud_init["consumer"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-consumer" })
  tags        = { Name = "vm-consumer" }
  depends_on  = [aws_iam_role_policy_attachment.consumer, aws_vpc_endpoint_policy.s3]
}

resource "aws_instance" "provider" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.provider[0].id
  vpc_security_group_ids = [aws_security_group.provider.id]
  user_data              = local.web_cloud_init["provider"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-provider" })
  tags        = { Name = "vm-provider" }
  depends_on  = [aws_vpc_endpoint.provider_s3, aws_route_table_association.provider]
}
