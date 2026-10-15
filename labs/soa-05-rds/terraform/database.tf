# database.tf
#
# Plain English: lab 05's database. RDS for MySQL 8.4 on db.t4g.micro,
# Multi-AZ (a standby in the other subnet's zone), 20 GiB gp2, encrypted
# with AWS's own key, private, in a subnet group of the template's two
# subnets, with its own parameter group (slow query log on, 1 second) and a
# single-AZ read replica. Everything a tear-down needs is set: no final
# snapshot, no deletion protection, automated backups deleted, and the
# lab's tags copied onto any snapshot, by hand too (spec §7.3 rule 12).
# Performance Insights stays off (ruling A34). Port 3306 is open to the lab
# instances and, once peered, the VPN server's VPC.

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "MySQL from the lab instances and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_vms" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
}

resource "aws_vpc_security_group_ingress_rule" "db_from_gateway" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
}

resource "aws_db_subnet_group" "db" {
  name       = "lab-${var.lab_id}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "lab-db" }
}

resource "aws_db_parameter_group" "mysql" {
  name   = "lab-${var.lab_id}-mysql84"
  family = "mysql8.4"
  parameter {
    name  = "slow_query_log"
    value = "1"
  }
  parameter {
    name  = "long_query_time"
    value = "1"
  }
  parameter {
    name  = "log_output"
    value = "FILE"
  }
  tags = { Name = "lab-mysql84" }
}

resource "aws_db_instance" "primary" {
  identifier                   = "db-${var.name_prefix}"
  engine                       = "mysql"
  engine_version               = "8.4"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp2"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "labdb"
  username                     = "labadmin"
  password                     = var.admin_password
  db_subnet_group_name         = aws_db_subnet_group.db.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.mysql.name
  publicly_accessible          = false
  backup_retention_period      = 1
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-primary" }
}

resource "aws_db_instance" "replica" {
  identifier                   = "db-${var.name_prefix}-replica"
  replicate_source_db          = aws_db_instance.primary.identifier
  instance_class               = "db.t4g.micro"
  storage_type                 = "gp2"
  multi_az                     = false
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.mysql.name
  publicly_accessible          = false
  backup_retention_period      = 0
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-replica" }
}
