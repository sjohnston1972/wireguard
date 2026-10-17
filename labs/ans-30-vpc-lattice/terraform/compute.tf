# compute.tf
#
# Plain English: lab 30's three instances (t4g.nano, Amazon Linux 2023),
# each serving a page naming itself (lab-web.service, python3 on port 80).
# vm-client, in vpc-lab with the template's sg-vms, runs as the client role
# and has lattice-curl: curl signed with the instance's role credentials
# (SigV4 for vpc-lattice-svcs, the payload unsigned, as Lattice requires).
# vm-svc-a (vpc-lab) and vm-svc-b (vpc-svc-b) are the services' targets: they
# admit HTTP from VPC Lattice's own addresses (AWS's managed prefix list)
# and SSH from their VPC's Instance Connect Endpoint; vm-svc-a, in vpc-lab, also
# admits SSH and HTTP from the VPN server's VPC once vpc-lab is peered (ruling
# A45). vpc-svc-b is never peered, so vm-svc-b has no gateway rules.

locals {
  pages = {
    client = "vm-client in vpc-lab, the Lattice client"
    svc_a  = "svc-a answered: vm-svc-a in vpc-lab"
    svc_b  = "svc-b answered: vm-svc-b in vpc-svc-b"
  }
  web_units = { for k, text in local.pages : k => join("\n", [
    "[Unit]",
    "Description=Lab 30 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"${text}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ]) }
  lattice_curl = join("\n", [
    "#!/bin/sh",
    "# lattice-curl <url> [curl options]: curl, signed (SigV4) as this instance's role, for VPC Lattice.",
    "T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
    "md() { curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$1; }",
    "ROLE=$(md iam/security-credentials/)",
    "CREDS=$(md iam/security-credentials/$ROLE)",
    "get() { printf '%s' \"$CREDS\" | python3 -c \"import json, sys; print(json.load(sys.stdin)['$1'])\"; }",
    "exec curl -sS --aws-sigv4 'aws:amz:${var.region}:vpc-lattice-svcs' --user \"$(get AccessKeyId):$(get SecretAccessKey)\" -H \"x-amz-security-token: $(get Token)\" -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' \"$@\"",
    "",
  ])
  web_cloud_init = { for k, unit in local.web_units : k => "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = concat(
      [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = unit }],
      k == "client" ? [{ path = "/usr/local/bin/lattice-curl", permissions = "0755", content = local.lattice_curl }] : []
    )
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}" }
}

resource "aws_security_group" "targets_a" {
  name        = "lab-targets-a"
  description = "vm-svc-a: HTTP from VPC Lattice, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-targets-a" }
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_lattice" {
  security_group_id = aws_security_group.targets_a.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.lattice.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_ssh_eice" {
  security_group_id            = aws_security_group.targets_a.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_ssh_gateway" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_http_gateway" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "targets_a_all" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "targets_b" {
  name        = "lab-targets-b"
  description = "vm-svc-b: HTTP from VPC Lattice, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.svc_b.id
  tags        = { Name = "sg-targets-b" }
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_lattice" {
  security_group_id = aws_security_group.targets_b.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.lattice.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_ssh_eice" {
  security_group_id            = aws_security_group.targets_b.id
  referenced_security_group_id = aws_security_group.eice_svc_b.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "targets_b_all" {
  security_group_id = aws_security_group.targets_b.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.client.name
  user_data              = local.web_cloud_init["client"]

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
  depends_on  = [aws_iam_role_policy_attachment.client]
}

resource "aws_instance" "svc_a" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.targets_a.id]
  user_data              = local.web_cloud_init["svc_a"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc-a" })
  tags        = { Name = "vm-svc-a" }
}

resource "aws_instance" "svc_b" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.svc_b[0].id
  vpc_security_group_ids = [aws_security_group.targets_b.id]
  user_data              = local.web_cloud_init["svc_b"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc-b" })
  tags        = { Name = "vm-svc-b" }
  depends_on  = [aws_route_table_association.svc_b]
}
