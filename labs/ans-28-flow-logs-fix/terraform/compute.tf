# compute.tf
#
# Plain English: lab 28's three instances, all t4g.nano. vm-client in the
# client VPC (snet-private-1; also in the template's sg-vms, so the VPN
# server can reach it when peered) is where the requests start. vm-svc in
# snet-svc serves a page on port 80 behind the load balancer; its security
# group, sg-svc, admits port 80 only from snet-nlb's range, which is the
# other half of fault 1 (readme, What was broken). vm-monitor in snet-nlb is
# the mirror target: it admits VXLAN (UDP 4789) from the service VPC.

locals {
  svc_unit = join("\n", [
    "[Unit]",
    "Description=Lab 28 service page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  svc_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-svc behind nlb-svc: it works\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.svc_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "client" {
  name        = "lab-client"
  description = "vm-client: ping from the service VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-client" }
}

resource "aws_vpc_security_group_ingress_rule" "client_ping" {
  security_group_id = aws_security_group.client.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_security_group" "svc" {
  name        = "lab-svc"
  description = "vm-svc: HTTP from the NLB subnet, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-svc" }
}

# FAULT 1 (with the target group): HTTP only from snet-nlb, but client IP preservation delivers vpc-lab addresses.
resource "aws_vpc_security_group_ingress_rule" "svc_http" {
  security_group_id = aws_security_group.svc.id
  cidr_ipv4         = local.nlb_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "svc_ssh" {
  security_group_id            = aws_security_group.svc.id
  referenced_security_group_id = aws_security_group.service_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "svc_all" {
  security_group_id = aws_security_group.svc.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "monitor" {
  name        = "lab-monitor"
  description = "vm-monitor: VXLAN mirror traffic from the service VPC, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-monitor" }
}

resource "aws_vpc_security_group_ingress_rule" "monitor_vxlan" {
  security_group_id = aws_security_group.monitor.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "udp"
  from_port         = 4789
  to_port           = 4789
}

resource "aws_vpc_security_group_ingress_rule" "monitor_ssh" {
  security_group_id            = aws_security_group.monitor.id
  referenced_security_group_id = aws_security_group.service_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "monitor_all" {
  security_group_id = aws_security_group.monitor.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.client.id]
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "svc" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.svc.id
  vpc_security_group_ids = [aws_security_group.svc.id]
  user_data              = local.svc_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc" })
  tags        = { Name = "vm-svc" }
  depends_on  = [aws_vpc_endpoint.service_s3, aws_route_table_association.svc, aws_network_acl_association.svc]
}

resource "aws_instance" "monitor" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.nlb.id
  vpc_security_group_ids = [aws_security_group.monitor.id]
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-monitor" })
  tags        = { Name = "vm-monitor" }
  depends_on  = [aws_vpc_endpoint.service_s3, aws_route_table_association.nlb]
}
