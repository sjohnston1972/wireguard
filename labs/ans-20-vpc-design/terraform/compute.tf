# compute.tf
#
# Plain English: lab 20's one instance, vm-dual (t4g.nano, Amazon Linux
# 2023), in snet-dual-1 with an IPv4 address from the secondary range and one
# IPv6 address from the IPAM pool's /56. It serves a page on port 80 on both
# families (python3 bound to ::). Its security group, sg-dual, admits SSH
# and HTTP from the prefix list pl-admin (the VPN server's VPC and vpc-lab's
# primary range; ruling A45 through the list) and SSH from the Instance
# Connect Endpoint; nothing from the internet in either family (ruling P6).

locals {
  dual_unit = join("\n", [
    "[Unit]",
    "Description=Lab 20 page on port 80, IPv4 and IPv6",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --bind :: --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dual_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-dual: dual stack in ${var.lab_id}\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.dual_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "dual" {
  name        = "lab-dual"
  description = "vm-dual: SSH and HTTP from the admin prefix list, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-dual" }
}

resource "aws_vpc_security_group_ingress_rule" "dual_ssh_admin" {
  security_group_id = aws_security_group.dual.id
  prefix_list_id    = aws_ec2_managed_prefix_list.admin.id
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "dual_http_admin" {
  security_group_id = aws_security_group.dual.id
  prefix_list_id    = aws_ec2_managed_prefix_list.admin.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "dual_ssh_eice" {
  security_group_id            = aws_security_group.dual.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "dual_all_v4" {
  security_group_id = aws_security_group.dual.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "dual_all_v6" {
  security_group_id = aws_security_group.dual.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "dual" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.dual[0].id
  ipv6_address_count     = 1
  vpc_security_group_ids = [aws_security_group.dual.id]
  user_data              = local.dual_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-dual" })
  tags        = { Name = "vm-dual" }
  depends_on  = [aws_route.dual_v4, aws_route.dual_v6, aws_route_table_association.dual]
}
