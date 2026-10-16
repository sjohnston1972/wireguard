# data.tf
#
# Plain English: lab 08's data VPC, vpc-data (the slot's second /20), peered
# to the app VPC (vpc-lab). One subnet, snet-db, holds vm-db (MariaDB on TCP
# 3306, user app with the session's password) and the data VPC's own Instance
# Connect Endpoint, in the same subnet so the subnet's network ACL never
# stands between them (ruling P17). snet-db has its own network ACL, acl-db,
# and vm-db its own security group, sg-db. THREE THINGS HERE ARE BROKEN ON
# PURPOSE (readme, What was broken); each is marked FAULT.
#
# Tear-down note (ruling A78, pre-flight C10): destroying the ACL association
# hands snet-db back to the VPC's untagged default network ACL, which the
# lab role's guard refuses; the destroy ends on the safety net, which removes
# snet-db and acl-db itself. That is by design and the run still ends clean.

locals {
  data_cidr = cidrsubnet(var.address_space, 2, 1)
  db_cidr   = cidrsubnet(local.data_cidr, 4, 0)
  # FAULT 3 aims here: the app VPC's second subnet, where nothing runs (vm-web is in the first).
  wrong_cidr = cidrsubnet(local.vpc_cidr, 4, 1)
  # The SQL that makes the database and its user, passed to mysql as one argument (no shell quoting).
  db_sql = "CREATE DATABASE IF NOT EXISTS shop; CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY '${var.admin_password}'; GRANT ALL ON shop.* TO 'app'@'%';"
}

resource "aws_vpc" "data" {
  cidr_block           = local.data_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-data" }
}

resource "aws_subnet" "db" {
  vpc_id                  = aws_vpc.data.id
  cidr_block              = local.db_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-db" }
}

# FAULT 1: no route back to the app VPC through the peering (rt-private, on the app side, has its route).
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.data.id
  tags   = { Name = "rt-data" }
}

resource "aws_route_table_association" "db" {
  subnet_id      = aws_subnet.db.id
  route_table_id = aws_route_table.data.id
}

resource "aws_vpc_endpoint" "data_s3" {
  vpc_id            = aws_vpc.data.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.data.id]
  tags              = { Name = "vpce-s3-data" }
}

resource "aws_vpc_peering_connection" "app_data" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.data.id
  auto_accept = true
  tags        = { Name = "pcx-app-data" }
}

resource "aws_route" "app_to_data" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.data_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.app_data.id
}

resource "aws_network_acl" "db" {
  vpc_id = aws_vpc.data.id
  tags   = { Name = "acl-db" }
}

resource "aws_network_acl_association" "db" {
  network_acl_id = aws_network_acl.db.id
  subnet_id      = aws_subnet.db.id
}

resource "aws_network_acl_rule" "in_mysql" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 100
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = local.vpc_cidr
  from_port      = 3306
  to_port        = 3306
}

# Replies to vm-db's own downloads (packages through the S3 endpoint). Any port from 1024 up, so it also admits 3306 from anywhere: rule 100 above is the intended one.
resource "aws_network_acl_rule" "in_replies" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 110
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 1024
  to_port        = 65535
}

# FAULT 2: HTTPS out (packages), but no outbound rule for ephemeral ports: vm-db's replies to the app VPC are dropped.
resource "aws_network_acl_rule" "out_https" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 100
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 443
  to_port        = 443
}

resource "aws_security_group" "eice_data" {
  name        = "lab-eice-data"
  description = "Instance Connect Endpoint in vpc-data: SSH out to vm-db"
  vpc_id      = aws_vpc.data.id
  tags        = { Name = "sg-eice-data" }
}

resource "aws_vpc_security_group_egress_rule" "eice_data_ssh" {
  security_group_id = aws_security_group.eice_data.id
  cidr_ipv4         = local.data_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "data" {
  subnet_id          = aws_subnet.db.id
  security_group_ids = [aws_security_group.eice_data.id]
  preserve_client_ip = false
  tags               = { Name = "eice-data" }
}

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "vm-db: MySQL from the app VPC, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.data.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_ssh" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.eice_data.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# FAULT 3: MySQL from the wrong /24 (the app VPC's second subnet, not vm-web's).
resource "aws_vpc_security_group_ingress_rule" "db_mysql" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = local.wrong_cidr
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
}

resource "aws_vpc_security_group_egress_rule" "db_all" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "db" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.db.id
  vpc_security_group_ids = [aws_security_group.db.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/my.cnf.d/lab.cnf", permissions = "0644", content = "[mysqld]\nbind-address = 0.0.0.0\n" }]
    runcmd = [
      "for i in 1 2 3 4 5; do dnf install -y mariadb105-server && break; sleep 10; done",
      "systemctl enable --now mariadb",
      ["mysql", "-e", local.db_sql],
    ]
  }))}"
  user_data_replace_on_change = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-db" })
  tags        = { Name = "vm-db" }
  depends_on  = [aws_vpc_endpoint.data_s3, aws_route_table_association.db, aws_network_acl_rule.in_replies, aws_network_acl_rule.out_https, aws_network_acl_association.db]
}
