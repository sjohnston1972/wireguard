# data.tf
#
# Plain English: lab 11's data tier, in two subnets of its own (the slot's
# /24s 2 and 3) with no route to the internet: RDS for MySQL 8.4 on
# db.t4g.micro, Multi-AZ, never publicly accessible (ruling P16), and one
# ElastiCache for Valkey node, encrypted at rest (ruling P17). Each admits
# only the app tier's security group and, once peered, the VPN server's
# range. Nothing lingers: no final snapshot, no deletion protection,
# automated backups deleted with the database.

resource "aws_subnet" "data" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, 2 + count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-data-${count.index + 1}" }
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-data" }
}

resource "aws_route_table_association" "data" {
  count          = 2
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "MySQL from the app tier and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
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

resource "aws_security_group" "cache" {
  name        = "lab-cache"
  description = "Valkey from the app tier and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_app" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_gateway" {
  security_group_id = aws_security_group.cache.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
}

resource "aws_db_subnet_group" "data" {
  name       = "lab-${var.lab_id}-data"
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "lab-data" }
}

resource "aws_db_instance" "app" {
  identifier                   = "db-${var.name_prefix}"
  engine                       = "mysql"
  engine_version               = "8.4"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp2"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "appdb"
  username                     = "labadmin"
  password                     = var.admin_password
  db_subnet_group_name         = aws_db_subnet_group.data.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  publicly_accessible          = false
  backup_retention_period      = 1
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-app" }
}

resource "aws_elasticache_subnet_group" "data" {
  name       = "lab-${var.lab_id}-cache"
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "lab-cache-subnets" }
}

resource "aws_elasticache_replication_group" "app" {
  replication_group_id       = "c${var.name_prefix}"
  description                = "lab ${var.lab_id}: the app tier's cache"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.data.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false
  automatic_failover_enabled = false
  multi_az_enabled           = false
  snapshot_retention_limit   = 0
  apply_immediately          = true
  tags                       = { Name = "cache-app" }
}
