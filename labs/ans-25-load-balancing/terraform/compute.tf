# compute.tf
#
# Plain English: lab 25's four instances, each also in the template's sg-vms
# (SSH from the Instance Connect Endpoint, anything from the VPN server's
# range when peered, everything out). vm-blue (snet-private-1) and vm-green
# (snet-private-2), t4g.nano, each serve a page naming itself on port 80
# (vm-green also /green/) to the ALB and the NLB only (sg-web). vm-client
# (t4g.nano, snet-inspected) is the machine whose internet traffic the
# appliance inspects. vm-appliance (t4g.small, snet-appliance; ruling P14)
# answers the GWLB's health check on port 8080 at once, then installs a
# compiler through the NAT gateway and builds AWS's open-source GWLB tunnel
# handler, gwlbtun, which takes the GENEVE packets apart and hands them back
# (several minutes after the lab is ready; the ready check does not wait).

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 25 web page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  health_unit = join("\n", [
    "[Unit]",
    "Description=Lab 25 appliance health check on port 8080",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  gwlbtun_unit = join("\n", [
    "[Unit]",
    "Description=AWS Gateway Load Balancer tunnel handler (lab 25 appliance)",
    "After=network-online.target",
    "ConditionPathExists=/opt/gwlbtun/gwlbtun",
    "[Service]",
    "WorkingDirectory=/opt/gwlbtun",
    "ExecStart=/opt/gwlbtun/gwlbtun -c /opt/gwlbtun/example-scripts/create-route.sh -r /opt/gwlbtun/example-scripts/create-route.sh",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  blue_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-blue (blue target group)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
  green_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-green (green target group)\n" },
      { path = "/srv/www/green/index.html", permissions = "0644", content = "vm-green, chosen by the /green/ rule\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
  appliance_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-appliance health check\n" },
      { path = "/etc/systemd/system/lab-health.service", permissions = "0644", content = local.health_unit },
      { path = "/etc/systemd/system/gwlbtun.service", permissions = "0644", content = local.gwlbtun_unit },
      { path = "/etc/sysctl.d/90-lab-forward.conf", permissions = "0644", content = "net.ipv4.ip_forward = 1\n" },
    ]
    runcmd = [
      "sysctl --system",
      "systemctl daemon-reload",
      "systemctl enable --now lab-health.service",
      "for i in 1 2 3 4 5; do dnf install -y gcc gcc-c++ cmake make git && break; sleep 10; done",
      "git clone --depth 1 https://github.com/aws-samples/aws-gateway-load-balancer-tunnel-handler /opt/gwlbtun",
      "cd /opt/gwlbtun && cmake . && make",
      "systemctl enable --now gwlbtun.service",
    ]
  }))}"
}

resource "aws_security_group" "web" {
  name        = "lab-web"
  description = "Web instances: HTTP from the ALB and the NLB"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "web_from_nlb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.nlb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_security_group" "appliance" {
  name        = "lab-appliance"
  description = "The appliance: GENEVE and health checks from the GWLB subnet"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-appliance" }
}

resource "aws_vpc_security_group_ingress_rule" "appliance_geneve" {
  security_group_id = aws_security_group.appliance.id
  cidr_ipv4         = local.appliance_cidr
  ip_protocol       = "udp"
  from_port         = 6081
  to_port           = 6081
}

resource "aws_vpc_security_group_ingress_rule" "appliance_health" {
  security_group_id = aws_security_group.appliance.id
  cidr_ipv4         = local.appliance_cidr
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
}

resource "aws_security_group" "client" {
  name        = "lab-client"
  description = "vm-client: ping from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-client" }
}

resource "aws_vpc_security_group_ingress_rule" "client_ping" {
  security_group_id = aws_security_group.client.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_instance" "blue" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.web.id]
  user_data              = local.blue_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-blue" })
  tags        = { Name = "vm-blue" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "green" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[1].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.web.id]
  user_data              = local.green_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-green" })
  tags        = { Name = "vm-green" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.inspected.id
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
  depends_on  = [aws_route.inspected_gwlbe, aws_route_table_association.inspected]
}

resource "aws_instance" "appliance" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.small"
  subnet_id              = aws_subnet.appliance.id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.appliance.id]
  user_data              = local.appliance_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-appliance" })
  tags        = { Name = "vm-appliance" }
  depends_on  = [aws_route.appliance_nat, aws_route_table_association.appliance]
}
