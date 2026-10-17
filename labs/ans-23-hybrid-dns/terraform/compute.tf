# compute.tf
#
# Plain English: lab 23's two instances (t4g.nano, Amazon Linux 2023).
# vm-cloud, in vpc-lab, serves a page naming itself and has dig (bind-utils).
# vm-dns, the data centre's DNS server, at local.dns_ip in vpc-onprem, runs
# dnsmasq (from Amazon Linux's own repository, through the S3 endpoint) as
# lab-dns.service, on its own address only (Amazon Linux's systemd-resolved
# keeps 127.0.0.53): it answers app.corp.<prefix>.internal itself and nothing
# else under corp, forwards cloud.<prefix>.internal to the Resolver's inbound
# endpoint (whose two addresses AWS chose, read here by reference, so vm-dns is
# made after the endpoint), and everything else to Amazon's DNS. Each admits
# SSH from its VPC's Instance Connect Endpoint and, once peered, SSH and HTTP
# from the VPN server's VPC (ruling A45); vm-dns admits DNS from the whole
# slot, vm-cloud HTTP from the data centre.

locals {
  cloud_unit = join("\n", [
    "[Unit]",
    "Description=Lab 23 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"vm-cloud in vpc-lab, app.${local.cloud_domain}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  cloud_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.cloud_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service", "for i in 1 2 3 4 5; do dnf install -y bind-utils && break; sleep 10; done"]
  }))}"

  # The inbound endpoint's addresses (AWS chose them), sorted so the file is stable.
  inbound_addresses = sort([for a in aws_route53_resolver_endpoint.inbound.ip_address : a.ip])
  dnsmasq_conf = join("\n", concat([
    "# Lab 23: the pretend data centre's DNS server.",
    "listen-address=${local.dns_ip}",
    "bind-interfaces",
    "no-resolv",
    "no-hosts",
    "log-queries",
    "log-facility=-",
    "server=169.254.169.253",
    "local=/${local.corp_domain}/",
    "address=/app.${local.corp_domain}/${local.dns_ip}",
    ], [for ip in local.inbound_addresses : "server=/${local.cloud_domain}/${ip}"], [
    "",
  ]))
  dns_unit = join("\n", [
    "[Unit]",
    "Description=Lab 23 on-prem DNS (dnsmasq)",
    "After=network-online.target",
    "Wants=network-online.target",
    "[Service]",
    "ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/lab-dnsmasq.conf",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dns_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/etc/lab-dnsmasq.conf", permissions = "0644", content = local.dnsmasq_conf },
      { path = "/etc/systemd/system/lab-dns.service", permissions = "0644", content = local.dns_unit },
    ]
    runcmd = [
      "for i in 1 2 3 4 5; do dnf install -y dnsmasq bind-utils && break; sleep 10; done",
      "systemctl daemon-reload",
      "systemctl enable --now lab-dns.service",
    ]
  }))}"
}

resource "aws_security_group" "cloud" {
  name        = "lab-cloud"
  description = "vm-cloud: SSH from the Instance Connect Endpoint, HTTP from the data centre, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cloud" }
}

resource "aws_vpc_security_group_ingress_rule" "cloud_ssh_eice" {
  security_group_id            = aws_security_group.cloud.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "cloud_http_onprem" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "cloud_ssh_gateway" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "cloud_http_gateway" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "cloud_all" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "dns" {
  name        = "lab-dns"
  description = "vm-dns: DNS from the slot, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-dns" }
}

resource "aws_vpc_security_group_ingress_rule" "dns_udp" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "dns_tcp" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "dns_ssh_eice" {
  security_group_id            = aws_security_group.dns.id
  referenced_security_group_id = aws_security_group.eice_onprem.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "dns_ssh_gateway" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "dns_http_gateway" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "dns_all" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "cloud" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.cloud.id]
  user_data              = local.cloud_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-cloud" })
  tags        = { Name = "vm-cloud" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "dns" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.onprem.id
  private_ip             = local.dns_ip
  vpc_security_group_ids = [aws_security_group.dns.id]
  user_data              = local.dns_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-dns" })
  tags        = { Name = "vm-dns" }
  depends_on  = [aws_vpc_endpoint.onprem_s3, aws_route_table_association.onprem]
}
