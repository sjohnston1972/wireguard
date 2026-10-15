# client.tf
#
# Plain English: vm-client, a t4g.nano Amazon Linux 2023 instance with the
# MySQL client (mariadb105, from the S3-hosted repositories through the
# gateway endpoint) and a ~/.my.cnf for labadmin that points mysql at the
# primary and, with --defaults-group-suffix=-replica, at the replica. It
# connects over TLS (ssl=1: MySQL 8.4 uses caching_sha2_password, which the
# MariaDB client completes over TLS; the server certificate is not checked). The
# password is the session's, in user data like the login (ruling A12).

locals {
  my_cnf = join("\n", [
    "[client]",
    "ssl=1",
    "host=${aws_db_instance.primary.address}",
    "user=labadmin",
    "password=${var.admin_password}",
    "database=labdb",
    "[client-replica]",
    "host=${aws_db_instance.replica.address}",
    "",
  ])
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/home/labadmin/.my.cnf", owner = "labadmin:labadmin", permissions = "0600", content = local.my_cnf, defer = true }]
    runcmd      = ["for i in 1 2 3 4 5; do dnf install -y mariadb105 && break; sleep 20; done"]
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_vpc_endpoint.s3]
}
