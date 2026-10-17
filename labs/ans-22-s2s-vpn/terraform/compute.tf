# compute.tf
#
# Plain English: lab 22's instance on the AWS side, vm-aws (t4g.nano,
# Amazon Linux 2023) in snet-private-1, serving a page naming itself. It
# keeps the template's sg-vms (SSH from eice-lab, the VPN server's range
# when peered) and adds sg-aws: ping and HTTP from vpc-onprem's /20, which
# arrive only through the VPN.

locals {
  aws_unit = join("\n", [
    "[Unit]",
    "Description=Lab page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  aws_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-aws in vpc-lab, reached over the VPN\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.aws_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "aws" {
  name        = "lab-aws"
  description = "vm-aws: ping and HTTP from the on-prem VPC, through the VPN"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-aws" }
}

resource "aws_vpc_security_group_ingress_rule" "aws_icmp_onprem" {
  security_group_id = aws_security_group.aws.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "aws_http_onprem" {
  security_group_id = aws_security_group.aws.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_instance" "aws" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.aws.id]
  user_data              = local.aws_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-aws" })
  tags        = { Name = "vm-aws" }
  depends_on  = [aws_vpc_endpoint.s3]
}
