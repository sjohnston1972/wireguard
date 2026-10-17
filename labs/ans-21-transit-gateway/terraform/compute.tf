# compute.tf
#
# Plain English: lab 21's two test instances, each serving a page naming
# itself: vm-a (t4g.nano) in spoke A, snet-private-1, and vm-b (t4g.nano) in
# spoke B, snet-spoke-b-1. Both admit ping (ICMP) and HTTP from anywhere in
# the lab's slot, so what stops one reaching the other is the transit
# gateway's route tables, never a security group. vm-a also keeps the
# template's sg-vms (SSH from eice-lab, the VPN server's range when peered);
# vm-b admits SSH from its own spoke's Instance Connect Endpoint.

locals {
  web_unit = {
    path        = "/etc/systemd/system/lab-web.service"
    permissions = "0644"
    content     = join("\n", ["[Unit]", "Description=Lab page on port 80", "After=network-online.target", "[Service]", "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www", "Restart=always", "[Install]", "WantedBy=multi-user.target", ""])
  }
  web_runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
}

resource "aws_security_group" "vms_a" {
  name        = "lab-vms-a"
  description = "vm-a: ping and HTTP from the lab slot"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-vms-a" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_icmp" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_http" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "vms_b" {
  name        = "lab-vms-b"
  description = "vm-b: ping and HTTP from the lab slot, SSH from the spoke B Instance Connect Endpoint"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-vms-b" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_icmp" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_http" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_ssh_eice" {
  security_group_id            = aws_security_group.vms_b.id
  referenced_security_group_id = aws_security_group.eice_spoke_b.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "vms_b_all" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "a" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.vms_a.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-a in spoke A (vpc-lab)\n" }, local.web_unit]
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
  volume_tags = merge(var.tags, { Name = "vm-a" })
  tags        = { Name = "vm-a" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "b" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.spoke_b[0].id
  vpc_security_group_ids = [aws_security_group.vms_b.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-b in spoke B (vpc-spoke-b)\n" }, local.web_unit]
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
  volume_tags = merge(var.tags, { Name = "vm-b" })
  tags        = { Name = "vm-b" }
  depends_on  = [aws_vpc_endpoint.spoke_b_s3]
}
