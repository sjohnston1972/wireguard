# london.tf
#
# Plain English: lab 26's London site. vm-london (t4g.nano) in the template's
# snet-private-1 serves a page naming itself on port 80. In front of it, the
# internet-facing Network Load Balancer nlb-<name_prefix>-ldn in a public
# subnet of its own (the slot's /24 2, with an internet gateway). The NLB has
# no security group (ruling P9), so it keeps each caller's address and
# vm-london's group admits port 80 from anywhere; the instance still has no
# public address of its own. CloudFront and Global Accelerator both reach
# London through this load balancer.

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 26 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  london_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-london in eu-west-2 (London)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-public-1" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "web" {
  name        = "lab-web"
  description = "vm-london: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_http" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "web_ssh" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "web_all" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "london" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data              = local.london_cloud_init

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

resource "aws_lb" "london" {
  name                       = "nlb-${var.name_prefix}-ldn"
  internal                   = false
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.public.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-ldn" }

  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "london" {
  name     = "tg-${var.name_prefix}-ldn"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.lab.id
  tags     = { Name = "tg-ldn" }
}

resource "aws_lb_target_group_attachment" "london" {
  target_group_arn = aws_lb_target_group.london.arn
  target_id        = aws_instance.london.id
  port             = 80
}

resource "aws_lb_listener" "london" {
  load_balancer_arn = aws_lb.london.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.london.arn
  }
  tags = { Name = "listener-ldn" }
}
